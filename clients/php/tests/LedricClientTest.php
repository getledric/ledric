<?php

declare(strict_types=1);

namespace Ledric\Tests;

use Ledric\LedricClient;
use Ledric\LedricError;
use PHPUnit\Framework\TestCase;

class LedricClientTest extends TestCase
{
    private MockHttpClient $http;
    private LedricClient $client;

    protected function setUp(): void
    {
        $this->http = new MockHttpClient();
        $this->client = new LedricClient('http://localhost:3000/', ['http' => $this->http]);
    }

    public function testReadStringRefHitsCorrectUrl(): void
    {
        $this->http->queueJson(200, [
            'id' => 'abc',
            'type' => 'blog_post',
            'slug' => 'hello',
            'version' => 1,
            'fields' => ['title' => 'Hello'],
        ]);
        $entry = $this->client->read('blog_post/hello');
        $this->assertNotNull($entry);
        $this->assertSame('Hello', $entry['fields']['title']);
        $this->assertSame('http://localhost:3000/entries/blog_post/hello', $this->http->requests[0]['url']);
    }

    public function testReadStructuredRef(): void
    {
        $this->http->queueJson(200, ['id' => 'abc', 'type' => 'blog_post', 'slug' => 'hello', 'version' => 1, 'fields' => []]);
        $entry = $this->client->read(['type' => 'blog_post', 'slug' => 'hello']);
        $this->assertNotNull($entry);
        $this->assertSame('blog_post', $entry['type']);
    }

    public function testReadReturnsNullOn404(): void
    {
        $this->http->queue(['status' => 404, 'body' => '{"error":{"code":"NOT_FOUND"}}']);
        $this->assertNull($this->client->read('blog_post/missing'));
    }

    public function testReadEncodesLocaleAndExpandFlags(): void
    {
        $this->http->queueJson(200, ['id' => 'abc', 'type' => 'blog_post', 'slug' => 'hello', 'version' => 1, 'fields' => []]);
        $this->client->read('blog_post/hello', [
            'locale' => 'fr',
            'expandAssets' => true,
            'resolveRefs' => true,
        ]);
        $url = $this->http->requests[0]['url'];
        $this->assertStringContainsString('locale=fr', $url);
        $this->assertStringContainsString('expand_assets=1', $url);
        $this->assertStringContainsString('resolve_refs=1', $url);
    }

    public function testExpandAssetsArrayBecomesCommaList(): void
    {
        $this->http->queueJson(200, ['id' => 'abc', 'type' => 'blog_post', 'slug' => 'hello', 'version' => 1, 'fields' => []]);
        $this->client->read('blog_post/hello', ['expandAssets' => ['hero', 'cover']]);
        $this->assertStringContainsString('expand_assets=hero%2Ccover', $this->http->requests[0]['url']);
    }

    public function testReadRefMustHaveSlash(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->client->read('not-a-ref');
    }

    public function testFindBuildsListResponse(): void
    {
        $this->http->queueJson(200, [
            'total' => 2,
            'offset' => 0,
            'results' => [
                ['id' => 'a', 'type' => 'blog_post', 'slug' => 'one', 'version' => 1, 'published_version' => 1, 'fields' => []],
                ['id' => 'b', 'type' => 'blog_post', 'slug' => 'two', 'version' => 1, 'published_version' => 1, 'fields' => []],
            ],
        ]);
        $list = $this->client->find('blog_post', ['limit' => 5]);
        $this->assertSame(2, $list['total']);
        $this->assertCount(2, $list['results']);
        $this->assertStringContainsString('limit=5', $this->http->requests[0]['url']);
    }

    public function testTypesReturnsModel(): void
    {
        $this->http->queueJson(200, ['schema_version' => 4, 'types' => [], 'capabilities' => []]);
        $this->assertSame(4, $this->client->types()['schema_version']);
    }

    public function testTypeNullOn404(): void
    {
        $this->http->queue(['status' => 404, 'body' => '{}']);
        $this->assertNull($this->client->type('nope'));
    }

    public function testAssetUrlIsPureHelperWithoutFetch(): void
    {
        $url = $this->client->assetUrl('019dc0b5deadbeef');
        $this->assertSame('http://localhost:3000/assets/019dc0b5deadbeef', $url);
        $this->assertCount(0, $this->http->requests);
    }

    public function testAssetBytesReturnsRawString(): void
    {
        $this->http->queue([
            'status' => 200,
            'headers' => ['content-type' => 'image/png'],
            'body' => 'PNGFAKEBYTES',
        ]);
        $bytes = $this->client->assetBytes('019dc0b5deadbeef');
        $this->assertSame('PNGFAKEBYTES', $bytes);
    }

    public function testAssetBytesNullOn404(): void
    {
        $this->http->queue(['status' => 404, 'body' => '']);
        $this->assertNull($this->client->assetBytes('missing'));
    }

    public function testRpcSuccess(): void
    {
        $this->http->queueJson(200, ['result' => ['name' => 'note', 'version' => 1]]);
        $result = $this->client->rpc('create_type', [
            'name' => 'note',
            'fields' => ['title' => ['type' => 'string', 'required' => true]],
        ]);
        $this->assertSame('note', $result['name']);

        $request = $this->http->requests[0];
        $this->assertSame('POST', $request['method']);
        $this->assertSame('http://localhost:3000/rpc', $request['url']);
        $this->assertSame('application/json', $request['headers']['Content-Type']);

        $payload = json_decode($request['body'] ?? '', true);
        $this->assertSame('create_type', $payload['tool']);
        $this->assertSame('note', $payload['args']['name']);
    }

    public function testRpcThrowsLedricErrorOnError(): void
    {
        $this->http->queueJson(400, ['error' => ['code' => 'TOOL_ERROR', 'message' => 'bad tool']]);
        $this->expectException(LedricError::class);
        $this->expectExceptionMessage('bad tool');
        $this->client->rpc('nope');
    }

    public function testReadHttp500RaisesLedricError(): void
    {
        $this->http->queue(['status' => 500, 'body' => '{}']);
        $this->expectException(LedricError::class);
        $this->client->read('blog_post/hello');
    }

    public function testGetBaseUrlStripsTrailingSlash(): void
    {
        $client = new LedricClient('http://example.com/', ['http' => $this->http]);
        $this->assertSame('http://example.com', $client->getBaseUrl());
    }

    public function testRefAttrsBuildsDataAttributes(): void
    {
        $this->assertSame(
            ['data-ledric-ref' => 'blog_post/hello'],
            LedricClient::refAttrs(['type' => 'blog_post', 'slug' => 'hello'])
        );
        $this->assertSame(
            ['data-ledric-ref' => 'note/a', 'data-ledric-field' => 'title'],
            LedricClient::refAttrs(['type' => 'note', 'slug' => 'a'], 'title')
        );
    }

    public function testRefAttrsReturnsEmptyForBadInput(): void
    {
        $this->assertSame([], LedricClient::refAttrs(null));
        $this->assertSame([], LedricClient::refAttrs(['type' => 'note']));
        $this->assertSame([], LedricClient::refAttrs(['slug' => 'a']));
    }

    public function testRefAttrsHtmlEscapesValues(): void
    {
        $this->assertSame(
            'data-ledric-ref="note/a"',
            LedricClient::refAttrsHtml(['type' => 'note', 'slug' => 'a'])
        );
        $this->assertSame(
            'data-ledric-ref="note/a" data-ledric-field="title"',
            LedricClient::refAttrsHtml(['type' => 'note', 'slug' => 'a'], 'title')
        );
        $this->assertSame(
            'data-ledric-ref="t/a&quot;b"',
            LedricClient::refAttrsHtml(['type' => 't', 'slug' => 'a"b'])
        );
        $this->assertSame('', LedricClient::refAttrsHtml(null));
    }
}
