<?php

declare(strict_types=1);

namespace Ledric;

interface HttpClient
{
    /**
     * Issue an HTTP request and return the bare result.
     *
     * @param array<string, string> $headers
     * @return array{status: int, headers: array<string, string>, body: string}
     */
    public function send(string $method, string $url, array $headers, ?string $body = null): array;
}
