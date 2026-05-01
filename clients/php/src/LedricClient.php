<?php

declare(strict_types=1);

namespace Ledric;

class LedricClient
{
    private string $baseUrl;
    private HttpClient $http;
    /** @var array<string, string> */
    private array $headers;

    /**
     * @param array{
     *     http?: HttpClient,
     *     headers?: array<string, string>
     * } $opts
     */
    public function __construct(string $baseUrl, array $opts = [])
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->http = $opts['http'] ?? new CurlHttpClient();
        $this->headers = array_merge(
            ['Accept' => 'application/json'],
            $opts['headers'] ?? []
        );
    }

    public function getBaseUrl(): string
    {
        return $this->baseUrl;
    }

    /**
     * GET /entries/:type/:slug — returns null on 404.
     *
     * @param string|array{type: string, slug: string} $ref
     * @param array{
     *     version?: int,
     *     locale?: string,
     *     expandAssets?: bool|array<int, string>,
     *     resolveRefs?: bool
     * } $opts
     * @return array<string, mixed>|null
     */
    public function read($ref, array $opts = []): ?array
    {
        [$type, $slug] = $this->parseRef($ref);
        $qs = $this->buildReadQs($opts);
        $url = $this->baseUrl . '/entries/' . rawurlencode($type) . '/' . rawurlencode($slug) . $qs;
        $res = $this->http->send('GET', $url, $this->headers);
        if ($res['status'] === 404) {
            return null;
        }
        return $this->jsonOrThrow($res, $url);
    }

    /**
     * GET /entries/:type — paginated list.
     *
     * @param array{
     *     limit?: int,
     *     offset?: int,
     *     locale?: string,
     *     expandAssets?: bool|array<int, string>,
     *     resolveRefs?: bool
     * } $opts
     * @return array{total: int, offset: int, results: array<int, array<string, mixed>>}
     */
    public function find(string $type, array $opts = []): array
    {
        $params = [];
        if (isset($opts['limit'])) {
            $params['limit'] = (string) $opts['limit'];
        }
        if (isset($opts['offset'])) {
            $params['offset'] = (string) $opts['offset'];
        }
        if (isset($opts['locale'])) {
            $params['locale'] = $opts['locale'];
        }
        $expandAssets = $this->encodeExpandAssets($opts['expandAssets'] ?? null);
        if ($expandAssets !== null) {
            $params['expand_assets'] = $expandAssets;
        }
        if (!empty($opts['resolveRefs'])) {
            $params['resolve_refs'] = '1';
        }
        if (isset($opts['tags']) && is_array($opts['tags']) && count($opts['tags']) > 0) {
            $params['tag'] = array_map('strval', $opts['tags']);
        }
        $qs = $this->qs($params);
        $url = $this->baseUrl . '/entries/' . rawurlencode($type) . $qs;
        $res = $this->http->send('GET', $url, $this->headers);
        /** @var array{total: int, offset: int, results: array<int, array<string, mixed>>} $body */
        $body = $this->jsonOrThrow($res, $url);
        return $body;
    }

    /**
     * GET /types — full content model.
     *
     * @return array<string, mixed>
     */
    public function types(): array
    {
        $url = $this->baseUrl . '/types';
        $res = $this->http->send('GET', $url, $this->headers);
        return $this->jsonOrThrow($res, $url);
    }

    /**
     * GET /types/:name — single type detail (or null).
     *
     * @return array<string, mixed>|null
     */
    public function type(string $name): ?array
    {
        $url = $this->baseUrl . '/types/' . rawurlencode($name);
        $res = $this->http->send('GET', $url, $this->headers);
        if ($res['status'] === 404) {
            return null;
        }
        return $this->jsonOrThrow($res, $url);
    }

    /**
     * GET /assets/:id/meta — asset metadata only (or null).
     *
     * @return array<string, mixed>|null
     */
    public function asset(string $id): ?array
    {
        $url = $this->baseUrl . '/assets/' . rawurlencode($id) . '/meta';
        $res = $this->http->send('GET', $url, $this->headers);
        if ($res['status'] === 404) {
            return null;
        }
        return $this->jsonOrThrow($res, $url);
    }

    /**
     * GET /assets — list assets.
     *
     * @param array{
     *     kind?: string,
     *     limit?: int,
     *     offset?: int
     * } $opts
     * @return array{total: int, offset: int, results: array<int, array<string, mixed>>}
     */
    public function assets(array $opts = []): array
    {
        $params = [];
        if (isset($opts['kind'])) {
            $params['kind'] = $opts['kind'];
        }
        if (isset($opts['limit'])) {
            $params['limit'] = (string) $opts['limit'];
        }
        if (isset($opts['offset'])) {
            $params['offset'] = (string) $opts['offset'];
        }
        if (isset($opts['tags']) && is_array($opts['tags']) && count($opts['tags']) > 0) {
            $params['tag'] = array_map('strval', $opts['tags']);
        }
        $url = $this->baseUrl . '/assets' . $this->qs($params);
        $res = $this->http->send('GET', $url, $this->headers);
        /** @var array{total: int, offset: int, results: array<int, array<string, mixed>>} $body */
        $body = $this->jsonOrThrow($res, $url);
        return $body;
    }

    /**
     * GET /tags — every tag in the env with usage counts.
     *
     * @return array<int, array{slug: string, label: string, asset_uses: int, entry_uses: int}>
     */
    public function tags(): array
    {
        $url = $this->baseUrl . '/tags';
        $res = $this->http->send('GET', $url, $this->headers);
        /** @var array<int, array{slug: string, label: string, asset_uses: int, entry_uses: int}> $body */
        $body = $this->jsonOrThrow($res, $url);
        return $body;
    }

    /**
     * Tag CRUD. Inputs are free-form; server normalizes (case/whitespace/leading-#).
     *
     * @param array<int, string> $tags
     * @return array<int, array{slug: string, label: string}>
     */
    public function addAssetTags(string $id, array $tags): array
    {
        return (array) $this->rpc('add_asset_tags', ['id' => $id, 'tags' => $tags]);
    }

    /** @param array<int, string> $tags @return array{removed: int} */
    public function removeAssetTags(string $id, array $tags): array
    {
        return (array) $this->rpc('remove_asset_tags', ['id' => $id, 'tags' => $tags]);
    }

    /**
     * @param string|array{type: string, slug: string} $ref
     * @param array<int, string> $tags
     * @return array<int, array{slug: string, label: string}>
     */
    public function addEntryTags($ref, array $tags): array
    {
        [$type, $slug] = $this->parseRef($ref);
        return (array) $this->rpc('add_entry_tags', [
            'ref' => ['type' => $type, 'slug' => $slug],
            'tags' => $tags
        ]);
    }

    /**
     * @param string|array{type: string, slug: string} $ref
     * @param array<int, string> $tags
     * @return array{removed: int}
     */
    public function removeEntryTags($ref, array $tags): array
    {
        [$type, $slug] = $this->parseRef($ref);
        return (array) $this->rpc('remove_entry_tags', [
            'ref' => ['type' => $type, 'slug' => $slug],
            'tags' => $tags
        ]);
    }

    /**
     * Relabel an existing tag. Slug is the stable identity; the new
     * label sticks but the slug never changes.
     *
     * @return array{slug: string, label: string}|null
     */
    public function updateTag(string $slug, string $label): ?array
    {
        $r = $this->rpc('update_tag', ['slug' => $slug, 'label' => $label]);
        return is_array($r) ? $r : null;
    }

    /**
     * Build an absolute asset URL with optional imgix-style transforms.
     * Accepts either a resolved asset array (preferred — uses `ref_key`)
     * or a bare ref_key string. Asset ids are NOT URL-bearing; resolve
     * via expand_assets or `client.asset()` first.
     *
     * @param string|array{ref_key: string} $refKeyOrAsset
     * @param array{
     *     w?: int,
     *     h?: int,
     *     fit?: 'clip'|'crop'|'cover'|'contain',
     *     q?: int,
     *     fm?: 'jpg'|'jpeg'|'png'|'webp'|'avif',
     *     auto?: 'format',
     *     dpr?: int|float
     * } $opts
     */
    public function assetUrl($refKeyOrAsset, array $opts = []): string
    {
        $refKey = is_array($refKeyOrAsset)
            ? (string) ($refKeyOrAsset['ref_key'] ?? '')
            : (string) $refKeyOrAsset;
        if ($refKey === '') {
            throw new \InvalidArgumentException('assetUrl: missing ref_key');
        }
        $params = [];
        if (isset($opts['w'])) {
            $params['w'] = (string) $opts['w'];
        }
        if (isset($opts['h'])) {
            $params['h'] = (string) $opts['h'];
        }
        if (isset($opts['fit'])) {
            $params['fit'] = (string) $opts['fit'];
        }
        if (isset($opts['q'])) {
            $params['q'] = (string) $opts['q'];
        }
        if (isset($opts['fm'])) {
            $params['fm'] = (string) $opts['fm'];
        }
        if (isset($opts['auto'])) {
            $params['auto'] = (string) $opts['auto'];
        }
        if (isset($opts['dpr'])) {
            $params['dpr'] = (string) $opts['dpr'];
        }
        return $this->baseUrl . '/assets/' . rawurlencode($refKey) . $this->qs($params);
    }

    /**
     * GET /assets/:ref_key — raw bytes. Returns null on 404. Accepts
     * either a ref_key string or a resolved asset array.
     *
     * @param string|array{ref_key: string} $refKeyOrAsset
     * @param array<string, mixed> $opts
     */
    public function assetBytes($refKeyOrAsset, array $opts = []): ?string
    {
        $url = $this->assetUrl($refKeyOrAsset, $opts);
        $res = $this->http->send('GET', $url, $this->headers);
        if ($res['status'] === 404) {
            return null;
        }
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw new LedricError($res['status'], $url, $res['body'], 'HTTP ' . $res['status'] . ' for ' . $url);
        }
        return $res['body'];
    }

    /**
     * Escape hatch — POST /rpc { tool, args }. Throws LedricError on failure.
     *
     * @param array<string, mixed> $args
     * @return mixed
     */
    public function rpc(string $tool, array $args = [])
    {
        $url = $this->baseUrl . '/rpc';
        $headers = array_merge($this->headers, ['Content-Type' => 'application/json']);
        $payload = json_encode(['tool' => $tool, 'args' => (object) $args]);
        if ($payload === false) {
            throw new LedricError(0, $url, null, 'json_encode failed');
        }
        $res = $this->http->send('POST', $url, $headers, $payload);
        $body = json_decode($res['body'], true);
        if (!is_array($body)) {
            throw new LedricError($res['status'], $url, $res['body'], 'invalid JSON response');
        }
        if ($res['status'] < 200 || $res['status'] >= 300 || isset($body['error'])) {
            $message = $body['error']['message'] ?? ('HTTP ' . $res['status']);
            throw new LedricError($res['status'], $url, $body, (string) $message);
        }
        return $body['result'] ?? null;
    }

    /**
     * Build the data-attribute array for tagging rendered HTML elements
     * with a ledric ref. The /admin/inline.js loader walks the DOM for
     * these and attaches floating "edit" affordances.
     *
     * @param array<string, mixed>|null $entry  Anything with type/slug keys.
     * @return array<string, string>
     */
    public static function refAttrs($entry, ?string $field = null): array
    {
        if (!is_array($entry)) {
            return [];
        }
        $type = $entry['type'] ?? null;
        $slug = $entry['slug'] ?? null;
        if (!is_string($type) || !is_string($slug)) {
            return [];
        }
        $out = ['data-ledric-ref' => $type . '/' . $slug];
        if (is_string($field) && $field !== '') {
            $out['data-ledric-field'] = $field;
        }
        return $out;
    }

    /**
     * Same as refAttrs(), but pre-rendered as a single string for direct
     * interpolation into HTML templates: `<h1 <?= LedricClient::refAttrsHtml($post, 'title') ?>>`.
     *
     * @param array<string, mixed>|null $entry
     */
    public static function refAttrsHtml($entry, ?string $field = null): string
    {
        $attrs = self::refAttrs($entry, $field);
        if (empty($attrs)) {
            return '';
        }
        $parts = [];
        foreach ($attrs as $k => $v) {
            $parts[] = $k . '="' . htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"';
        }
        return implode(' ', $parts);
    }

    // ---- internals -------------------------------------------------------

    /**
     * @param string|array{type: string, slug: string} $ref
     * @return array{0: string, 1: string}
     */
    private function parseRef($ref): array
    {
        if (is_array($ref)) {
            return [(string) $ref['type'], (string) $ref['slug']];
        }
        $ix = strpos($ref, '/');
        if ($ix === false) {
            throw new \InvalidArgumentException('Ref must be "type/slug", got "' . $ref . '"');
        }
        return [substr($ref, 0, $ix), substr($ref, $ix + 1)];
    }

    /**
     * @param array{version?: int, locale?: string, expandAssets?: bool|array<int, string>, resolveRefs?: bool} $opts
     */
    private function buildReadQs(array $opts): string
    {
        $params = [];
        if (isset($opts['version'])) {
            $params['version'] = (string) $opts['version'];
        }
        if (isset($opts['locale'])) {
            $params['locale'] = $opts['locale'];
        }
        $expandAssets = $this->encodeExpandAssets($opts['expandAssets'] ?? null);
        if ($expandAssets !== null) {
            $params['expand_assets'] = $expandAssets;
        }
        if (!empty($opts['resolveRefs'])) {
            $params['resolve_refs'] = '1';
        }
        return $this->qs($params);
    }

    /**
     * @param bool|array<int, string>|null $expand
     */
    private function encodeExpandAssets($expand): ?string
    {
        if ($expand === null) {
            return null;
        }
        if ($expand === true) {
            return '1';
        }
        if ($expand === false) {
            return '0';
        }
        if (is_array($expand)) {
            return implode(',', $expand);
        }
        return null;
    }

    /**
     * Build a query string. Values may be a string (single) or an array
     * (repeated, e.g. `?tag=a&tag=b`).
     *
     * @param array<string, string|array<int, string>> $params
     */
    private function qs(array $params): string
    {
        if (empty($params)) {
            return '';
        }
        $pairs = [];
        foreach ($params as $k => $v) {
            if (is_array($v)) {
                foreach ($v as $item) {
                    $pairs[] = rawurlencode($k) . '=' . rawurlencode((string) $item);
                }
            } else {
                $pairs[] = rawurlencode($k) . '=' . rawurlencode($v);
            }
        }
        return '?' . implode('&', $pairs);
    }

    /**
     * @param array{status: int, headers: array<string, string>, body: string} $res
     * @return array<string, mixed>
     */
    private function jsonOrThrow(array $res, string $url): array
    {
        if ($res['status'] < 200 || $res['status'] >= 300) {
            $body = json_decode($res['body'], true);
            throw new LedricError(
                $res['status'],
                $url,
                $body !== null ? $body : $res['body'],
                'HTTP ' . $res['status'] . ' for ' . $url
            );
        }
        $decoded = json_decode($res['body'], true);
        if (!is_array($decoded)) {
            throw new LedricError($res['status'], $url, $res['body'], 'invalid JSON response');
        }
        return $decoded;
    }
}
