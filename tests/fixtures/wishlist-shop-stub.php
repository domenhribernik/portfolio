<?php
declare(strict_types=1);

// A fake shop for tests/wishlist-controller.test.php, run as a built-in server
// router on 127.0.0.1:8970. The controller's fetcher refuses loopback
// addresses, and WISHLIST_FETCH_ALLOW lets exactly this host:port through, so
// the auto-fill path can be exercised end to end with no network.
//
//   /og.html          a page with og:title / og:image (relative image URL)
//   /amazon.html      an Amazon product page shape: no og tags, #productTitle
//                     and #landingImage with data-old-hires
//   /jar.webp         a real WebP (shop images often are)
//   /masher.jpg       a real JPEG
//   /not-an-image     HTML served where an image was promised
//   /to-private       a redirect to a private address, which must be refused

const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUjogZ2QtanBlZyB2MS4wICh1c2luZyBJSkcgSlBFRyB2OTApLCBxdWFsaXR5ID0gNzAK/9sAQwAKBwcIBwYKCAgICwoKCw4YEA4NDQ4dFRYRGCMfJSQiHyIhJis3LyYpNCkhIjBBMTQ5Oz4+PiUuRElDPEg3PT47/9sAQwEKCwsODQ4cEBAcOygiKDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7/8AAEQgAMABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8AmoorA1PU7y31CWKKbai4wNoPYe1eHgMBUx1R06bSaV9T3cRiIYeHNI36K5b+2dQ/5+P/ABxf8KP7Z1D/AJ+P/HF/wr2P9WMZ/NH73/kcX9rUOz/D/M6miuW/tnUP+fj/AMcX/CuktXaS0hkc5Zo1JPqcV52PymvgIxlVad3bS/r2OnDYyniG1BPTuS0UUV5R2hXLaz/yFZv+A/8AoIrqa5vVrW4k1KV47eV1OMFUJB4FfScNzjDFycml7r3duq7nlZrFyopJX1/RmZRU/wBiu/8An1m/79mj7Fd/8+s3/fs1959Yo/zr71/mfO+yqfyv7n/kQV2Fl/x4W/8A1yX+QrlvsV3/AM+s3/fs11VmpWygVgQRGoIPUcV8rxPVpzo0+WSer2afTybPYymEozldW0/Umooor4k98KKKKACiiigAooooAKKKKAP/2Q==';
const WEBP_B64 = 'UklGRtQAAABXRUJQVlA4IMgAAAAwBwCdASpAADAAPpk4l0gloyIhMB1cALATCWYAwNoQfgGhAcYDxAL4A6WrymQD49YbVNN/8++28Ky5JaYFc/8SeAAA03Xi7IDVJTr/hWujDr/98HCb013/50jqBsnC9vtMgTYsQo9mFiwgwD6Oxd8BJTXzF/n/T0XWY2jm72Ie+uGrSGGuYlUIYFb20BT0EYc4mSmnmdzUoMQkXzndvpjbn+JLR7vJjYN9GUZxpJ03UQ3TiqeH1YjLWapua8k/nn8j5Sr/AAAAAA==';

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

switch ($path) {
    case '/og.html':
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html><head><title>ignored</title>'
            . '<meta property="og:title" content="Glass jar with lid - IKEA">'
            . '<meta property="og:image" content="/jar.webp">'
            . '</head><body>shop</body></html>';
        break;

    case '/amazon.html':
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html><head><title>Amazon.de: WMF Kartoffelstampfer : Küche</title></head><body>'
            . '<span id="productTitle" class="a-size-large">   WMF Profi Plus Kartoffelstampfer Edelstahl 28,5 cm, Cromargan   </span>'
            . '<img alt="" src="data:image/gif;base64,R0lGOD" data-old-hires="http://127.0.0.1:8970/masher.jpg" '
            . 'id="landingImage" data-a-dynamic-image="{&quot;http://127.0.0.1:8970/masher.jpg&quot;:[500,500]}">'
            . '</body></html>';
        break;

    case '/captcha.html':
        // What Amazon serves a server it suspects of being a bot: a 200 with a
        // captcha form and the shop's own name as the title.
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html><head><title>Amazon.de</title></head><body>'
            . '<form method="get" action="/errors/validateCaptcha"><input name="field-keywords"></form>'
            . '</body></html>';
        break;

    case '/flaky.jpg':
        // A network blip: the first request hangs past the fetcher's timeout,
        // the next one answers. A marker file remembers which is which.
        $marker = sys_get_temp_dir() . '/wishlist-stub-flaky-' . getmypid();
        if (!file_exists($marker)) {
            touch($marker);
            sleep(7);
            exit;
        }
        unlink($marker);
        header('Content-Type: image/jpeg');
        echo base64_decode(JPEG_B64);
        break;

    case '/pixel.gif':
        // A tracking pixel posing as a product picture.
        header('Content-Type: image/gif');
        echo base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
        break;

    case '/jar.webp':
        header('Content-Type: image/webp');
        echo base64_decode(WEBP_B64);
        break;

    case '/masher.jpg':
        header('Content-Type: image/jpeg');
        echo base64_decode(JPEG_B64);
        break;

    case '/not-an-image':
        header('Content-Type: text/html');
        echo '<html>surprise</html>';
        break;

    case '/to-private':
        header('Location: http://10.0.0.1/admin', true, 302);
        break;

    default:
        http_response_code(404);
        echo 'not found';
}
