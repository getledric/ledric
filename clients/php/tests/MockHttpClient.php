<?php

declare(strict_types=1);

namespace Ledric\Tests;

use Ledric\HttpClient;

class MockHttpClient implements HttpClient
{
    /** @var array<int, array{method: string, url: string, headers: array<string, string>, body: ?string}> */
    public array $requests = [];

    /** @var array<int, array{status: int, headers?: array<string, string>, body: string}> */
    public array $responses = [];

    /**
     * @param array{status: int, headers?: array<string, string>, body: string} $response
     */
    public function queue(array $response): void
    {
        $this->responses[] = $response;
    }

    public function queueJson(int $status, $body): void
    {
        $this->responses[] = [
            'status' => $status,
            'body' => json_encode($body) ?: '',
        ];
    }

    public function send(string $method, string $url, array $headers, ?string $body = null): array
    {
        $this->requests[] = [
            'method' => $method,
            'url' => $url,
            'headers' => $headers,
            'body' => $body,
        ];
        if (empty($this->responses)) {
            return ['status' => 500, 'headers' => [], 'body' => '{"error":"no response queued"}'];
        }
        $response = array_shift($this->responses);
        return [
            'status' => $response['status'],
            'headers' => $response['headers'] ?? [],
            'body' => $response['body'],
        ];
    }
}
