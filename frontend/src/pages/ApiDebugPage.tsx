import { useState, useEffect } from 'react';
import { requestJson } from '../util/apiClient';
import { useToast } from '../util/toast';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

type QueryParameter = {
  key: string;
  value: string;
};

type Server = {
  id: string;
  server_nickname: string;
  service_type: string;
  url: string;
};

type ApiResponse = {
  success: boolean;
  status_code: number;
  status_text: string;
  headers: Record<string, string>;
  url: string;
  method: string;
  response_text: string;
  response_json?: any;
  response_xml?: string;
  response_format: string;
  elapsed_ms: number;
  error?: string;
};

type ExampleEndpoint = {
  method: string;
  endpoint: string;
  format: 'json' | 'xml';
  params?: QueryParameter[];
};

const ApiDebugPage = () => {
  const [httpMethod, setHttpMethod] = useState<string>('GET');
  const [apiEndpoint, setApiEndpoint] = useState<string>('');
  const [responseFormat, setResponseFormat] = useState<'json' | 'xml'>('json');
  const [selectedServer, setSelectedServer] = useState<string>('');
  const [parameters, setParameters] = useState<QueryParameter[]>([{ key: '', value: '' }]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'formatted' | 'raw' | 'headers' | 'curl'>('formatted');
  const toast = useToast();

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      const response = await requestJson<{ data: Server[] }>('/admin/api/v1/servers');
      setServers(response.data || []);
    } catch (error) {
      toast.showToast({
        type: 'error',
        title: 'Failed to load servers',
        description: String(error)
      });
    }
  };

  const addParameter = () => {
    setParameters([...parameters, { key: '', value: '' }]);
  };

  const removeParameter = (index: number) => {
    if (parameters.length > 1) {
      setParameters(parameters.filter((_, i) => i !== index));
    }
  };

  const updateParameter = (index: number, field: 'key' | 'value', value: string) => {
    const newParams = [...parameters];
    newParams[index][field] = value;
    setParameters(newParams);
  };

  const getFullUrl = (): string => {
    const server = servers.find((s) => s.id === selectedServer);
    if (!server || !apiEndpoint) {
      return 'Select a server and enter an endpoint to see the full URL';
    }

    const baseUrl = server.url.replace(/\/$/, '');
    const endpoint = apiEndpoint.startsWith('/') ? apiEndpoint : '/' + apiEndpoint;

    const validParams = parameters.filter((p) => p.key && p.value);
    const queryString = validParams.length > 0
      ? '?' + validParams.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
      : '';

    return baseUrl + endpoint + queryString;
  };

  const executeRequest = async () => {
    if (!selectedServer || !apiEndpoint) {
      toast.showToast({
        type: 'error',
        title: 'Validation Error',
        description: 'Please select a server and enter an endpoint'
      });
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);
    setActiveTab('formatted');

    try {
      const result = await requestJson<ApiResponse>('/admin/settings/api_debug_execute', {
        method: 'POST',
        body: JSON.stringify({
          method: httpMethod,
          endpoint: apiEndpoint,
          response_format: responseFormat,
          parameters: parameters.filter((p) => p.key && p.value),
          server_id: selectedServer
        })
      });

      if (result.success) {
        setResponse(result);
      } else {
        setError(result.error || 'Request failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadExample = (example: ExampleEndpoint) => {
    setHttpMethod(example.method);
    setApiEndpoint(example.endpoint);
    setResponseFormat(example.format);
    if (example.params && example.params.length > 0) {
      setParameters(example.params);
    } else {
      setParameters([{ key: '', value: '' }]);
    }
  };

  const formatJson = (json: any): string => {
    try {
      return JSON.stringify(json, null, 2);
    } catch {
      return 'Unable to format JSON';
    }
  };

  const formatXml = (xml: string): string => {
    try {
      const PADDING = '  ';
      const reg = /(>)(<)(\/*)/g;
      let formatted = xml.replace(reg, '$1\r\n$2$3');
      let pad = 0;

      return formatted.split('\r\n').map((line) => {
        let indent = 0;
        if (line.match(/.+<\/\w[^>]*>$/)) {
          indent = 0;
        } else if (line.match(/^<\/\w/) && pad > 0) {
          pad -= 1;
        } else if (line.match(/^<\w[^>]*[^\/]>.*$/)) {
          indent = 1;
        } else {
          indent = 0;
        }

        const padding = PADDING.repeat(pad);
        pad += indent;
        return padding + line;
      }).join('\n');
    } catch {
      return xml;
    }
  };

  const generateCurlCommand = (): string => {
    if (!response) return '';

    let cmd = `curl -X ${response.method} \\\n  "${response.url}"`;

    const skipHeaders = ['content-length', 'host', 'user-agent', 'connection'];

    if (response.headers) {
      Object.entries(response.headers).forEach(([key, value]) => {
        if (!skipHeaders.includes(key.toLowerCase())) {
          cmd += ` \\\n  -H "${key}: ${value}"`;
        }
      });
    }

    return cmd;
  };

  const copyCurlCommand = async () => {
    const curlCmd = generateCurlCommand();
    try {
      await navigator.clipboard.writeText(curlCmd);
      toast.showToast({
        type: 'success',
        title: 'Copied',
        description: 'cURL command copied to clipboard'
      });
    } catch {
      toast.showToast({
        type: 'error',
        title: 'Copy Failed',
        description: 'Failed to copy to clipboard'
      });
    }
  };

  const getStatusColor = (statusCode: number): string => {
    if (statusCode >= 200 && statusCode < 300) return 'text-green-500';
    if (statusCode >= 400) return 'text-destructive';
    return 'text-yellow-500';
  };

  const examples: Record<string, ExampleEndpoint[]> = {
    plex: [
      { method: 'GET', endpoint: '/identity', format: 'xml' },
      { method: 'GET', endpoint: '/library/sections', format: 'xml' },
      { method: 'GET', endpoint: '/status/sessions', format: 'json' },
      { method: 'GET', endpoint: '/library/sections/1/all', format: 'xml', params: [{ key: 'type', value: '1' }] }
    ],
    jellyfin: [
      { method: 'GET', endpoint: '/System/Info', format: 'json' },
      { method: 'GET', endpoint: '/Users', format: 'json' },
      { method: 'GET', endpoint: '/Library/VirtualFolders', format: 'json' },
      { method: 'GET', endpoint: '/Items', format: 'json', params: [{ key: 'Recursive', value: 'true' }, { key: 'IncludeItemTypes', value: 'Movie' }] }
    ],
    emby: [
      { method: 'GET', endpoint: '/System/Info', format: 'json' },
      { method: 'GET', endpoint: '/Users', format: 'json' },
      { method: 'GET', endpoint: '/Library/VirtualFolders', format: 'json' },
      { method: 'GET', endpoint: '/Sessions', format: 'json' }
    ],
    kavita: [
      { method: 'GET', endpoint: '/api/Server/version', format: 'json' },
      { method: 'GET', endpoint: '/api/Library', format: 'json' },
      { method: 'GET', endpoint: '/api/Series', format: 'json', params: [{ key: 'libraryId', value: '1' }] },
      { method: 'GET', endpoint: '/api/Stats/server-info', format: 'json' }
    ],
    audiobookshelf: [
      { method: 'GET', endpoint: '/api/status', format: 'json' },
      { method: 'GET', endpoint: '/api/libraries', format: 'json' },
      { method: 'GET', endpoint: '/api/users', format: 'json' },
      { method: 'GET', endpoint: '/api/items', format: 'json', params: [{ key: 'library', value: 'lib_1' }] }
    ],
    komga: [
      { method: 'GET', endpoint: '/api/v1/actuator/health', format: 'json' },
      { method: 'GET', endpoint: '/api/v1/libraries', format: 'json' },
      { method: 'GET', endpoint: '/api/v1/series', format: 'json', params: [{ key: 'library_id', value: '1' }] },
      { method: 'GET', endpoint: '/api/v1/users/me', format: 'json' }
    ]
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <i className="fa-solid fa-code text-blue-500 text-lg" />
          </div>
          <div>
            <h1 className="text-2xl font-bold mb-1">API Debug</h1>
            <p className="text-sm text-muted-foreground">Test API endpoints for your configured media servers</p>
          </div>
        </div>

        {/* Info Notice */}
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <i className="fa-solid fa-info-circle text-blue-500 text-xs" />
            </div>
            <div>
              <h4 className="font-medium text-blue-500 mb-1">Debug Tool</h4>
              <p className="text-sm text-foreground/80">
                This tool allows you to test API endpoints using the stored server credentials. All requests are authenticated automatically using your configured server settings.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* API Testing Form */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <i className="fa-solid fa-terminal text-blue-500 text-sm" />
            </div>
            <div>
              <CardTitle>API Request Builder</CardTitle>
              <CardDescription>Configure and execute API requests to your media servers</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* HTTP Method */}
            <div className="space-y-2">
              <Label htmlFor="http-method">HTTP Method</Label>
              <Select value={httpMethod} onValueChange={setHttpMethod}>
                <SelectTrigger id="http-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                  <SelectItem value="HEAD">HEAD</SelectItem>
                  <SelectItem value="OPTIONS">OPTIONS</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* API Endpoint */}
            <div className="space-y-2">
              <Label htmlFor="api-endpoint">API Endpoint</Label>
              <Input
                id="api-endpoint"
                type="text"
                placeholder="/api/v1/libraries"
                value={apiEndpoint}
                onChange={(e) => setApiEndpoint(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Enter relative path (e.g., /api/v1/libraries)</p>
            </div>

            {/* Response Format */}
            <div className="space-y-2">
              <Label htmlFor="response-format">Response Format</Label>
              <Select value={responseFormat} onValueChange={(value) => setResponseFormat(value as 'json' | 'xml')}>
                <SelectTrigger id="response-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="xml">XML</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Server Selection */}
            <div className="space-y-2">
              <Label htmlFor="server-select">Server</Label>
              <Select value={selectedServer} onValueChange={setSelectedServer}>
                <SelectTrigger id="server-select">
                  <SelectValue placeholder="Select a server..." />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.server_nickname} ({server.service_type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Parameters Section */}
          <div className="space-y-2">
            <Label>Query Parameters</Label>
            <div className="space-y-2">
              {parameters.map((param, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Input
                    type="text"
                    placeholder="Parameter name"
                    className="flex-1"
                    value={param.key}
                    onChange={(e) => updateParameter(index, 'key', e.target.value)}
                  />
                  <Input
                    type="text"
                    placeholder="Parameter value"
                    className="flex-1"
                    value={param.value}
                    onChange={(e) => updateParameter(index, 'value', e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => removeParameter(index)}
                    disabled={parameters.length === 1}
                  >
                    <i className="fa-solid fa-trash text-xs" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" size="sm" variant="outline" onClick={addParameter}>
              <i className="fa-solid fa-plus mr-2" />
              Add Parameter
            </Button>
          </div>

          {/* Request URL Preview */}
          <div className="space-y-2">
            <Label>Full Request URL</Label>
            <div className="bg-muted rounded-lg p-3 font-mono text-sm">
              <span className="text-muted-foreground">{getFullUrl()}</span>
            </div>
          </div>

          {/* Execute Button */}
          <div className="flex gap-2 items-center">
            <Button
              onClick={executeRequest}
              disabled={loading || !selectedServer || !apiEndpoint}
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                  Executing...
                </>
              ) : (
                <>
                  <i className="fa-solid fa-play mr-2" />
                  Execute Request
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error Section */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <i className="fa-solid fa-exclamation-triangle text-destructive text-xs" />
            </div>
            <div>
              <h4 className="font-medium text-destructive mb-1">Request Failed</h4>
              <div className="text-sm text-foreground/80">{error}</div>
            </div>
          </div>
        </div>
      )}

      {/* Results Section */}
      {response && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                <i className="fa-solid fa-clipboard-list text-green-500 text-sm" />
              </div>
              <div>
                <CardTitle>Response</CardTitle>
                <CardDescription>API response details and formatted output</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Response Summary */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-muted/30 rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">Status</div>
                <div className={`text-2xl font-bold ${getStatusColor(response.status_code)}`}>
                  {response.status_code}
                </div>
                <div className="text-sm text-muted-foreground">{response.status_text}</div>
              </div>

              <div className="bg-muted/30 rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">Response Time</div>
                <div className="text-2xl font-bold">{response.elapsed_ms}</div>
                <div className="text-sm text-muted-foreground">milliseconds</div>
              </div>

              <div className="bg-muted/30 rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">Content Type</div>
                <div className="text-lg font-bold">
                  {response.headers['content-type']?.split(';')[0] || response.headers['Content-Type']?.split(';')[0] || '-'}
                </div>
              </div>

              <div className="bg-muted/30 rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">Content Length</div>
                <div className="text-2xl font-bold">
                  {response.headers['content-length'] || response.headers['Content-Length'] || response.response_text.length}
                </div>
                <div className="text-sm text-muted-foreground">bytes</div>
              </div>
            </div>

            {/* Response Tabs */}
            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="formatted">Formatted Response</TabsTrigger>
                <TabsTrigger value="raw">Raw Response</TabsTrigger>
                <TabsTrigger value="headers">Headers</TabsTrigger>
                <TabsTrigger value="curl">cURL Command</TabsTrigger>
              </TabsList>

              {/* Formatted Response */}
              <TabsContent value="formatted">
                <pre className="bg-muted rounded-lg p-4 overflow-auto max-h-96 text-sm whitespace-pre-wrap">
                  {response.response_format === 'xml' && response.response_xml
                    ? formatXml(response.response_xml)
                    : response.response_json
                    ? formatJson(response.response_json)
                    : 'Response could not be formatted'}
                </pre>
              </TabsContent>

              {/* Raw Response */}
              <TabsContent value="raw">
                <pre className="bg-muted rounded-lg p-4 overflow-auto max-h-96 text-sm whitespace-pre-wrap">
                  {response.response_text || 'No response body received'}
                </pre>
              </TabsContent>

              {/* Headers */}
              <TabsContent value="headers">
                <div className="rounded-lg border shadow-sm overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Header</TableHead>
                        <TableHead>Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(response.headers).map(([key, value]) => (
                        <TableRow key={key}>
                          <TableCell className="font-medium">{key}</TableCell>
                          <TableCell className="break-all">{value}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              {/* cURL Command */}
              <TabsContent value="curl">
                <pre className="bg-muted rounded-lg p-4 overflow-auto text-sm whitespace-pre-wrap">
                  {generateCurlCommand()}
                </pre>
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={copyCurlCommand}>
                    <i className="fa-solid fa-copy mr-2" />
                    Copy cURL Command
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Quick Examples */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
              <i className="fa-solid fa-lightbulb text-yellow-500 text-sm" />
            </div>
            <div>
              <CardTitle>Common API Endpoints</CardTitle>
              <CardDescription>Click any example to populate the request builder above</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Plex Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-plex-500">
                <i className="fa-solid fa-play mr-1" />
                Plex
              </h4>
              <div className="space-y-2 text-xs">
                {examples.plex.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint} ({example.format.toUpperCase()})
                  </button>
                ))}
              </div>
            </div>

            {/* Jellyfin Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-jellyfin-500">
                <i className="fa-solid fa-cube mr-1" />
                Jellyfin
              </h4>
              <div className="space-y-2 text-xs">
                {examples.jellyfin.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint}
                  </button>
                ))}
              </div>
            </div>

            {/* Emby Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-emby-500">
                <i className="fa-solid fa-play-circle mr-1" />
                Emby
              </h4>
              <div className="space-y-2 text-xs">
                {examples.emby.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint}
                  </button>
                ))}
              </div>
            </div>

            {/* Kavita Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-kavita-500">
                <i className="fa-solid fa-book mr-1" />
                Kavita
              </h4>
              <div className="space-y-2 text-xs">
                {examples.kavita.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint}
                  </button>
                ))}
              </div>
            </div>

            {/* AudiobookShelf Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-audiobookshelf-500">
                <i className="fa-solid fa-headphones mr-1" />
                AudiobookShelf
              </h4>
              <div className="space-y-2 text-xs">
                {examples.audiobookshelf.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint}
                  </button>
                ))}
              </div>
            </div>

            {/* Komga Examples */}
            <div className="bg-muted rounded-lg p-4">
              <h4 className="font-semibold text-sm mb-2 text-komga-500">
                <i className="fa-solid fa-book-open mr-1" />
                Komga
              </h4>
              <div className="space-y-2 text-xs">
                {examples.komga.map((example, index) => (
                  <button
                    key={index}
                    className="block w-full text-left hover:text-primary cursor-pointer"
                    onClick={() => loadExample(example)}
                  >
                    {example.method} {example.endpoint}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ApiDebugPage;
