<?php
declare(strict_types=1);

// The wish list's auto-fill: read a shop page for a product name and picture,
// and fetch that picture so a copy can be kept on this server.
//
// The fetcher takes a URL from the request, so it is the one place in the
// wish list that could be pointed at this server's own network (SSRF). Every
// hop, redirects included, is resolved and refused unless every address it
// resolves to is public, and the connection is pinned to the address that was
// checked so a second DNS answer cannot swap it out.
//
// Only class definitions here: nothing runs on include.
//
// Test seam: WISHLIST_FETCH_ALLOW names host:port pairs (comma separated) that
// skip the address check. tests/wishlist-controller.test.php lets exactly its
// stub shop through and nothing else; production never sets it.

/** We will not fetch that address at all (answered as 422). */
final class WishlistFetchRefused extends RuntimeException
{
}

/** We tried, and the other end did not give us what we needed (answered as 502). */
final class WishlistFetchFailed extends RuntimeException
{
}

final class WishlistFetch
{
    public const PAGE_MAX_BYTES  = 1_500_000;
    public const IMAGE_MAX_BYTES = 8_000_000;
    private const MAX_REDIRECTS  = 3;
    private const TIMEOUT        = 5;

    /**
     * A product name and picture out of a shop page's HTML. Amazon's own
     * elements win when present (its pages carry no og tags worth having),
     * then Open Graph, then Twitter cards, then <title>.
     *
     * @return array{title: ?string, image_url: ?string}
     */
    public static function parse(string $html, string $baseUrl): array
    {
        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $xp = new DOMXPath($doc);

        // A bot wall (Amazon answers servers it distrusts with a 200 captcha
        // page titled "Amazon.de") carries no product, whatever its title says.
        $captcha = "contains(translate(@action, 'CAPTCHA', 'captcha'), 'captcha')";
        if ($xp->query("//form[$captcha]")->length > 0) {
            return ['title' => null, 'image_url' => null];
        }

        $text = static function (string $query) use ($xp): ?string {
            $node = $xp->query($query)->item(0);
            if ($node === null) return null;
            $value = trim(preg_replace('/\s+/u', ' ', $node->nodeValue ?? '') ?? '');
            return $value === '' ? null : $value;
        };

        $title = $text('//*[@id="productTitle"]')
            ?? $text('//meta[@property="og:title"]/@content')
            ?? $text('//meta[@name="twitter:title"]/@content')
            ?? $text('//title');

        $image = $text('//*[@id="landingImage"]/@data-old-hires')
            ?? self::largestDynamicImage($text('//*[@id="landingImage"]/@data-a-dynamic-image'))
            ?? $text('//meta[@property="og:image"]/@content')
            ?? $text('//meta[@name="twitter:image"]/@content')
            ?? $text('//link[@rel="image_src"]/@href');

        return [
            'title'     => $title,
            'image_url' => $image !== null ? self::resolve($image, $baseUrl) : null,
        ];
    }

    /**
     * What an Amazon product link says about itself without loading the page,
     * for when the page is walled off: the slug before /dp/ is the product's
     * title, and the ASIN addresses a picture on Amazon's image host (a real
     * JPEG for most products, a 1x1 GIF for some newer ones, which the
     * caller must check). Null for anything that is not an Amazon link.
     *
     * @return array{title: ?string, image_url: ?string}|null
     */
    public static function amazonFallback(string $url): ?array
    {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        if (!preg_match('/(^|\.)amazon\.[a-z.]{2,6}$/', $host)) {
            return null;
        }
        $path = (string) parse_url($url, PHP_URL_PATH);
        if (!preg_match('#(?:^|/)(?:([^/]+)/)?(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})(?:[/?]|$)#i', $path, $m)) {
            return null;
        }
        $slug = rawurldecode($m[1] ?? '');
        $title = $slug !== '' && !in_array(strtolower($slug), ['gp', 'dp', 'exec', 'obidos'], true)
            ? trim(preg_replace('/[-_]+/', ' ', $slug) ?? '')
            : '';
        return [
            'title'     => $title !== '' ? $title : null,
            'image_url' => 'https://images-eu.ssl-images-amazon.com/images/P/' . strtoupper($m[2]) . '.03.LZZZZZZZ.jpg',
        ];
    }

    /**
     * GET a public http(s) URL, following at most three redirects, each one
     * checked like the first. Refuses (WishlistFetchRefused) anything that is
     * not plain http(s) or resolves to a private, loopback or reserved address.
     *
     * @return array{body: string, content_type: string, url: string}
     */
    public static function get(string $url, int $maxBytes, ?string $wantType = null): array
    {
        for ($hop = 0; $hop <= self::MAX_REDIRECTS; $hop++) {
            [$host, $port, $ip] = self::checkTarget($url);
            [$ok, $tooBig, $body, $status, $type, $location, $error] = self::attempt($url, "$host:$port:$ip", $maxBytes);
            if (!$ok && !$tooBig) {
                // A connection that dropped or stalled is usually a blip, and
                // one blip should not cost an item its picture. Retry once.
                [$ok, $tooBig, $body, $status, $type, $location, $error] = self::attempt($url, "$host:$port:$ip", $maxBytes);
            }

            if ($tooBig) {
                throw new WishlistFetchFailed('That page is too large to read.');
            }
            if (!$ok) {
                throw new WishlistFetchFailed("That page did not load ($error).");
            }
            if ($status >= 300 && $status < 400 && $location !== '') {
                $url = $location;
                continue;
            }
            if ($status < 200 || $status >= 300) {
                throw new WishlistFetchFailed("That page answered $status.");
            }
            if ($wantType !== null && !str_starts_with($type, $wantType)) {
                throw new WishlistFetchFailed('That link is not a picture.');
            }
            return ['body' => $body, 'content_type' => $type, 'url' => $url];
        }
        throw new WishlistFetchFailed('Too many redirects.');
    }

    /**
     * One request, pinned to the checked address, no redirects followed.
     *
     * @return array{0: bool, 1: bool, 2: string, 3: int, 4: string, 5: string, 6: string}
     */
    private static function attempt(string $url, string $pin, int $maxBytes): array
    {
        $body = '';
        $tooBig = false;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RESOLVE          => [$pin],
            CURLOPT_FOLLOWLOCATION   => false,
            CURLOPT_PROTOCOLS        => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT   => 3,
            CURLOPT_TIMEOUT          => self::TIMEOUT,
            CURLOPT_ENCODING         => '',
            CURLOPT_USERAGENT        => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            CURLOPT_HTTPHEADER       => ['Accept-Language: en,de;q=0.8'],
            CURLOPT_WRITEFUNCTION    => static function ($ch, string $chunk) use (&$body, &$tooBig, $maxBytes): int {
                $body .= $chunk;
                if (strlen($body) > $maxBytes) {
                    $tooBig = true;
                    return 0; // abort the transfer
                }
                return strlen($chunk);
            },
        ]);
        $ok       = curl_exec($ch) !== false;
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $type     = strtolower((string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
        $location = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        $error    = curl_error($ch);
        curl_close($ch);
        return [$ok, $tooBig, $body, $status, $type, $location, $error];
    }

    /**
     * The host, port and one checked address to pin the connection to.
     *
     * @return array{0: string, 1: int, 2: string}
     */
    private static function checkTarget(string $url): array
    {
        $parts  = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host   = strtolower(trim((string) ($parts['host'] ?? ''), '[]'));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '') {
            throw new WishlistFetchRefused('Only web links can be read.');
        }
        $port = (int) ($parts['port'] ?? ($scheme === 'https' ? 443 : 80));

        $ips = filter_var($host, FILTER_VALIDATE_IP) !== false ? [$host] : self::resolveHost($host);
        if ($ips === []) {
            throw new WishlistFetchFailed('That address does not exist.');
        }
        if (!self::allowlisted($host, $port)) {
            foreach ($ips as $ip) {
                if (!self::isPublicIp($ip)) {
                    throw new WishlistFetchRefused('That address is not on the public internet.');
                }
            }
        }
        // CURLOPT_RESOLVE wants IPv6 in brackets.
        $pin = str_contains($ips[0], ':') ? '[' . $ips[0] . ']' : $ips[0];
        return [$host, $port, $pin];
    }

    /** @return string[] */
    private static function resolveHost(string $host): array
    {
        $ips = gethostbynamel($host) ?: [];
        $aaaa = @dns_get_record($host, DNS_AAAA) ?: [];
        foreach ($aaaa as $record) {
            if (!empty($record['ipv6'])) {
                $ips[] = $record['ipv6'];
            }
        }
        return array_values(array_unique($ips));
    }

    public static function isPublicIp(string $ip): bool
    {
        // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as IPv4.
        if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m)) {
            $ip = $m[1];
        }
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return false;
        }
        // Ranges the filter flags do not cover: carrier-grade NAT, IPv6 unique-local.
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            $long = ip2long($ip);
            return !($long >= ip2long('100.64.0.0') && $long <= ip2long('100.127.255.255'));
        }
        return !preg_match('/^f[cd]/i', $ip);
    }

    private static function allowlisted(string $host, int $port): bool
    {
        $allow = getenv('WISHLIST_FETCH_ALLOW') ?: '';
        foreach (array_filter(array_map('trim', explode(',', $allow))) as $entry) {
            if (strtolower($entry) === "$host:$port") {
                return true;
            }
        }
        return false;
    }

    /** Amazon lists its gallery sizes as {"url": [w, h], ...}; take the widest. */
    private static function largestDynamicImage(?string $json): ?string
    {
        $map = $json !== null ? json_decode($json, true) : null;
        if (!is_array($map) || $map === []) return null;
        uksort($map, fn ($a, $b) => (($map[$b][0] ?? 0) <=> ($map[$a][0] ?? 0)));
        return (string) array_key_first($map);
    }

    /** A possibly relative reference made absolute against the page it was on. */
    private static function resolve(string $ref, string $base): ?string
    {
        if (preg_match('#^https?://#i', $ref)) return $ref;
        $b = parse_url($base);
        if (!isset($b['scheme'], $b['host'])) return null;
        $origin = $b['scheme'] . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
        if (str_starts_with($ref, '//')) return $b['scheme'] . ':' . $ref;
        if (str_starts_with($ref, '/')) return $origin . $ref;
        $dir = preg_replace('#/[^/]*$#', '/', $b['path'] ?? '/');
        return $origin . $dir . $ref;
    }
}
