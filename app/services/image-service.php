<?php
declare(strict_types=1);

/**
 * Image service — processing and filesystem storage.
 *
 * Validates, resizes, converts, and strips EXIF from uploaded images.
 * Supports HEIC/HEIF (iPhone photos) via the imagick extension —
 * these are converted to PNG internally before the GD pipeline processes them.
 * Does NOT touch the database — that is the controller's responsibility.
 *
 * Two-step usage (controller drives both):
 *   require_once __DIR__ . '/../services/image-service.php';
 *
 *   // 1. Process the raw upload
 *   $processed = ImageService::prepare($binaryData, [
 *       'size'       => 'medium',   // thumb | small | medium | large | original
 *       'format'     => 'webp',     // webp | jpeg | png  (default: webp)
 *       'strip_exif' => true,       // strip EXIF metadata (default: true)
 *       'quality'    => 80,         // output quality 1-100 (default: 80)
 *   ]);
 *   // $processed = ['data' => <binary>, 'mime' => 'image/webp', 'width' => 800, 'height' => 600]
 *
 *   // 2. Write to disk — returns storage metadata for the controller to persist
 *   $stored = ImageService::store($processed, 'botaniq');
 *   // $stored = ['uuid' => '...', 'folder' => 'botaniq', 'mime' => '...', 'width' => ..., 'height' => ..., 'file_size' => ...]
 *
 *   // To delete a stored file:
 *   ImageService::remove($uuid, $folder, $mimeType);
 */
class ImageService
{
    private const ALLOWED_MIMES = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/heic',
        'image/heif',
    ];

    // Absolute path to the uploads root (assets/uploads/)
    private const UPLOADS_ROOT = __DIR__ . '/../../assets/uploads';

    private const HEIC_MIMES = [
        'image/heic',
        'image/heif',
    ];

    private const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB

    private const SIZES = [
        'thumb'    => ['width' => 150,  'height' => 150,  'crop' => true],
        'small'    => ['width' => 400,  'height' => null,  'crop' => false],
        'medium'   => ['width' => 800,  'height' => null,  'crop' => false],
        'large'    => ['width' => 1200, 'height' => null,  'crop' => false],
        'original' => null, // no resize
    ];

    private const FORMAT_MAP = [
        'webp' => 'image/webp',
        'jpeg' => 'image/jpeg',
        'jpg'  => 'image/jpeg',
        'png'  => 'image/png',
    ];

    /**
     * Prepare an image for storage.
     *
     * @param  string $rawData  Raw binary image data.
     * @param  array  $options  Optional keys: size, format, strip_exif, quality.
     * @return array  ['data' => string, 'mime' => string, 'width' => int, 'height' => int]
     * @throws InvalidArgumentException  On bad input.
     * @throws RuntimeException          On processing failure.
     */
    public static function prepare(string $rawData, array $options = []): array
    {
        // --- Validate input size ---
        if ($rawData === '') {
            throw new InvalidArgumentException('Image data is empty');
        }
        if (strlen($rawData) > self::MAX_INPUT_BYTES) {
            throw new InvalidArgumentException('Image exceeds maximum allowed size of 20 MB');
        }

        // --- Validate MIME via actual content (not user-supplied headers) ---
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $mime  = $finfo->buffer($rawData);
        if (!in_array($mime, self::ALLOWED_MIMES, true)) {
            throw new InvalidArgumentException(
                'Invalid image type "' . $mime . '". Allowed: JPEG, PNG, WebP, GIF, HEIC'
            );
        }

        // --- Convert HEIC/HEIF to PNG so GD can process it ---
        if (in_array($mime, self::HEIC_MIMES, true)) {
            $rawData = self::convertHeicToPng($rawData);
            $mime = 'image/png';
        }

        // --- Parse options ---
        $sizeName  = $options['size']       ?? 'medium';
        $formatKey = $options['format']     ?? 'webp';
        $stripExif = $options['strip_exif'] ?? true;
        $quality   = $options['quality']    ?? 80;

        if (!array_key_exists($sizeName, self::SIZES)) {
            throw new InvalidArgumentException(
                'Unknown size "' . $sizeName . '". Allowed: ' . implode(', ', array_keys(self::SIZES))
            );
        }

        $formatKey = strtolower($formatKey);
        if (!isset(self::FORMAT_MAP[$formatKey])) {
            throw new InvalidArgumentException(
                'Unknown format "' . $formatKey . '". Allowed: ' . implode(', ', array_keys(self::FORMAT_MAP))
            );
        }

        $quality = max(1, min(100, (int) $quality));

        // --- Create GD resource from raw data ---
        $src = @imagecreatefromstring($rawData);
        if ($src === false) {
            throw new RuntimeException('Failed to decode image — file may be corrupt');
        }

        $srcW = imagesx($src);
        $srcH = imagesy($src);

        // --- Resize ---
        $sizeSpec = self::SIZES[$sizeName];
        $dst = self::resize($src, $srcW, $srcH, $sizeSpec);

        $outW = imagesx($dst);
        $outH = imagesy($dst);

        // --- Strip EXIF ---
        // GD already discards EXIF when creating a new image from scratch,
        // so the re-encoded output is inherently EXIF-free. When strip_exif
        // is false AND the output format matches the source AND size is
        // 'original', we skip re-encoding to preserve metadata.
        $skipReencode = (!$stripExif && $sizeName === 'original'
            && self::FORMAT_MAP[$formatKey] === $mime);

        if ($skipReencode) {
            imagedestroy($src);
            if ($dst !== $src) {
                imagedestroy($dst);
            }
            return [
                'data'   => $rawData,
                'mime'   => $mime,
                'width'  => $srcW,
                'height' => $srcH,
            ];
        }

        // --- Encode to target format ---
        $outputMime = self::FORMAT_MAP[$formatKey];
        $outputData = self::encode($dst, $formatKey, $quality);

        // --- Cleanup ---
        if ($dst !== $src) {
            imagedestroy($src);
        }
        imagedestroy($dst);

        return [
            'data'   => $outputData,
            'mime'   => $outputMime,
            'width'  => $outW,
            'height' => $outH,
        ];
    }

    /**
     * Write a processed image to the filesystem.
     *
     * Call this after prepare(). The controller then saves the returned
     * metadata array to the database.
     *
     * @param  array  $prepared  Return value from prepare().
     * @param  string $folder    Project subfolder name, e.g. "botaniq".
     * @return array  ['uuid' => string, 'folder' => string, 'mime' => string,
     *                 'width' => int, 'height' => int, 'file_size' => int]
     * @throws RuntimeException  If the file cannot be written.
     */
    public static function store(array $prepared, string $folder = 'general'): array
    {
        $folder = self::sanitizeFolder($folder);
        $ext    = self::mimeToExtension($prepared['mime']);
        $uuid   = self::generateUuid();
        $dir    = self::UPLOADS_ROOT . '/' . $folder;

        if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
            throw new RuntimeException('Failed to create upload directory: ' . $folder);
        }

        $path = $dir . '/' . $uuid . '.' . $ext;

        if (file_put_contents($path, $prepared['data']) === false) {
            throw new RuntimeException('Failed to write image to disk');
        }

        return [
            'uuid'      => $uuid,
            'folder'    => $folder,
            'mime'      => $prepared['mime'],
            'width'     => $prepared['width'],
            'height'    => $prepared['height'],
            'file_size' => strlen($prepared['data']),
        ];
    }

    /**
     * Delete a stored image from the filesystem.
     *
     * The controller is responsible for removing the DB row; this only
     * handles the file on disk.
     *
     * @param  string $uuid      The UUID stored in the database.
     * @param  string $folder    The folder stored in the database.
     * @param  string $mimeType  The mime_type stored in the database.
     * @throws RuntimeException  If the resolved path escapes the uploads root.
     */
    public static function remove(string $uuid, string $folder, string $mimeType): void
    {
        $ext  = self::mimeToExtension($mimeType);
        $path = realpath(self::UPLOADS_ROOT . '/' . $folder . '/' . $uuid . '.' . $ext);
        $root = realpath(self::UPLOADS_ROOT);

        // Reject anything that resolves outside the uploads root
        if ($path === false || $root === false || !str_starts_with($path, $root . DIRECTORY_SEPARATOR)) {
            throw new RuntimeException('Resolved path escapes the uploads directory');
        }

        if (file_exists($path) && !unlink($path)) {
            throw new RuntimeException('Failed to delete image file');
        }
    }

    /**
     * Validate and sanitize a folder name to prevent path traversal.
     * Allows alphanumeric characters, hyphens, and underscores only.
     *
     * @throws InvalidArgumentException  If the name is invalid.
     */
    public static function sanitizeFolder(string $folder): string
    {
        $folder = strtolower(trim($folder));
        if (!preg_match('/^[a-z0-9_-]{1,100}$/', $folder)) {
            throw new InvalidArgumentException(
                'Folder name must be 1-100 characters, alphanumeric, hyphens, or underscores only'
            );
        }
        return $folder;
    }

    /**
     * Convenience: prepare directly from a $_FILES entry.
     *
     * @param  array $fileEntry  A single $_FILES['field'] array.
     * @param  array $options    Same options as prepare().
     * @return array             Same return as prepare().
     */
    public static function prepareFromUpload(array $fileEntry, array $options = []): array
    {
        if (!isset($fileEntry['tmp_name'], $fileEntry['error'])) {
            throw new InvalidArgumentException('Invalid file upload entry');
        }
        if ($fileEntry['error'] !== UPLOAD_ERR_OK) {
            throw new InvalidArgumentException(
                'Upload error code ' . $fileEntry['error']
            );
        }
        if (!is_uploaded_file($fileEntry['tmp_name'])) {
            throw new InvalidArgumentException('File is not a valid upload');
        }

        $rawData = file_get_contents($fileEntry['tmp_name']);
        if ($rawData === false) {
            throw new RuntimeException('Failed to read uploaded file');
        }

        return self::prepare($rawData, $options);
    }

    //  Internal helpers
    private static function generateUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40); // version 4
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80); // variant RFC 4122
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    private static function mimeToExtension(string $mime): string
    {
        return match ($mime) {
            'image/webp' => 'webp',
            'image/jpeg' => 'jpg',
            'image/png'  => 'png',
            default      => throw new RuntimeException('No extension mapping for mime: ' . $mime),
        };
    }

    private static function convertHeicToPng(string $heicData): string
    {
        if (!extension_loaded('imagick')) {
            throw new RuntimeException(
                'The imagick PHP extension is required to process HEIC/HEIF images. '
                . 'Install it or convert the image to JPEG/PNG before uploading.'
            );
        }

        try {
            $imagick = new \Imagick();
            $imagick->readImageBlob($heicData);
            $imagick->setImageFormat('png');
            $pngData = $imagick->getImageBlob();
            $imagick->clear();
            $imagick->destroy();
        } catch (\ImagickException $e) {
            throw new RuntimeException('Failed to convert HEIC image: ' . $e->getMessage());
        }

        if ($pngData === '' || $pngData === false) {
            throw new RuntimeException('HEIC to PNG conversion produced empty output');
        }

        return $pngData;
    }

    private static function resize(\GdImage $src, int $srcW, int $srcH, ?array $spec): \GdImage
    {
        if ($spec === null) {
            // 'original' — return as-is
            return $src;
        }

        $targetW = $spec['width'];
        $targetH = $spec['height'];
        $crop    = $spec['crop'];

        if ($crop && $targetW && $targetH) {
            return self::cropResize($src, $srcW, $srcH, $targetW, $targetH);
        }

        // Scale proportionally by width
        if ($srcW <= $targetW) {
            // Already small enough
            return $src;
        }

        $ratio  = $targetW / $srcW;
        $newW   = $targetW;
        $newH   = (int) round($srcH * $ratio);

        $dst = imagecreatetruecolor($newW, $newH);
        self::preserveTransparency($dst);
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $newW, $newH, $srcW, $srcH);

        return $dst;
    }

    private static function cropResize(\GdImage $src, int $srcW, int $srcH, int $dstW, int $dstH): \GdImage
    {
        $srcRatio = $srcW / $srcH;
        $dstRatio = $dstW / $dstH;

        if ($srcRatio > $dstRatio) {
            // Source is wider — crop sides
            $cropH = $srcH;
            $cropW = (int) round($srcH * $dstRatio);
            $cropX = (int) round(($srcW - $cropW) / 2);
            $cropY = 0;
        } else {
            // Source is taller — crop top/bottom
            $cropW = $srcW;
            $cropH = (int) round($srcW / $dstRatio);
            $cropX = 0;
            $cropY = (int) round(($srcH - $cropH) / 2);
        }

        $dst = imagecreatetruecolor($dstW, $dstH);
        self::preserveTransparency($dst);
        imagecopyresampled($dst, $src, 0, 0, $cropX, $cropY, $dstW, $dstH, $cropW, $cropH);

        return $dst;
    }

    private static function preserveTransparency(\GdImage $img): void
    {
        imagealphablending($img, false);
        imagesavealpha($img, true);
        $transparent = imagecolorallocatealpha($img, 0, 0, 0, 127);
        imagefill($img, 0, 0, $transparent);
    }

    private static function encode(\GdImage $img, string $format, int $quality): string
    {
        ob_start();
        $ok = match ($format) {
            'webp'         => imagewebp($img, null, $quality),
            'jpeg', 'jpg'  => imagejpeg($img, null, $quality),
            'png'          => imagepng($img, null, (int) round(9 - ($quality / 100 * 9))),
            default        => false,
        };
        $data = ob_get_clean();

        if (!$ok || $data === '' || $data === false) {
            throw new RuntimeException('Failed to encode image as ' . $format);
        }

        return $data;
    }
}
