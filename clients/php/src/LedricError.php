<?php

declare(strict_types=1);

namespace Ledric;

class LedricError extends \RuntimeException
{
    public int $status;
    public string $url;
    /** @var mixed */
    public $body;

    /**
     * @param mixed $body
     */
    public function __construct(int $status, string $url, $body, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->url = $url;
        $this->body = $body;
    }
}
