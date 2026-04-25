<?php

declare(strict_types=1);

namespace Ledric;

class CurlHttpClient implements HttpClient
{
    private int $timeoutMs;

    public function __construct(int $timeoutMs = 10000)
    {
        $this->timeoutMs = $timeoutMs;
    }

    public function send(string $method, string $url, array $headers, ?string $body = null): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new LedricError(0, $url, null, 'curl_init failed');
        }

        $headerLines = [];
        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        $responseHeaders = [];

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT_MS => $this->timeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => $this->timeoutMs,
            CURLOPT_HEADERFUNCTION => function ($_ch, string $header) use (&$responseHeaders): int {
                $colon = strpos($header, ':');
                if ($colon !== false) {
                    $name = strtolower(trim(substr($header, 0, $colon)));
                    $value = trim(substr($header, $colon + 1));
                    if ($name !== '') {
                        $responseHeaders[$name] = $value;
                    }
                }
                return strlen($header);
            },
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $responseBody = curl_exec($ch);
        if ($responseBody === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new LedricError(0, $url, null, 'curl error: ' . $err);
        }

        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return [
            'status' => $status,
            'headers' => $responseHeaders,
            'body' => is_string($responseBody) ? $responseBody : '',
        ];
    }
}
