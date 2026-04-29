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
        $url = $this->baseUrl . '/assets' . $this->qs($params);
        $res = $this->http->send('GET', $url, $this->headers);
        /** @var array{total: int, offset: int, results: array<int, array<string, mixed>>} $body */
        $body = $this->jsonOrThrow($res, $url);
        return $body;
    }

    /**
     * Build an absolute asset URL — pure helper, no fetch.
     *
     * @param array{version?: int} $opts
     */
    public function assetUrl(string $id, array $opts = []): string
    {
        $qs = isset($opts['version']) ? '?version=' . rawurlencode((string) $opts['version']) : '';
        return $this->baseUrl . '/assets/' . rawurlencode($id) . $qs;
    }

    /**
     * GET /assets/:id — raw bytes. Returns null on 404.
     *
     * @param array{version?: int} $opts
     */
    public function assetBytes(string $id, array $opts = []): ?string
    {
        $url = $this->assetUrl($id, $opts);
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
     * @param array<string, string> $params
     */
    private function qs(array $params): string
    {
        if (empty($params)) {
            return '';
        }
        $pairs = [];
        foreach ($params as $k => $v) {
            $pairs[] = rawurlencode($k) . '=' . rawurlencode($v);
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
