import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts/AlertContext';
import { PageHeader } from '../components';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Switch } from '../components/ui/switch';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faCircleInfo,
  faTerminal,
  faTrash,
  faPlus,
  faPlay,
  faArrowUp,
  faArrowDown,
  faTriangleExclamation,
  faClipboardList,
  faCopy,
  faLightbulb,
  faCube,
  faPlayCircle,
  faBook,
  faHeadphones,
  faBookOpen,
} from '@fortawesome/free-solid-svg-icons';

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

type DebugLoggingSettings = {
  plex_http_log_enabled: boolean;
  plex_ws_log_enabled: boolean;
  jellyfin_ws_log_enabled: boolean;
  emby_ws_log_enabled: boolean;
  audiobookshelf_http_log_enabled: boolean;
};

type ExampleEndpoint = {
  method: string;
  endpoint: string;
  format: 'json' | 'xml';
  params?: QueryParameter[];
};

const AdminSettingsApiDebugPage = () => {
  const [httpMethod, setHttpMethod] = useState<string>('GET');
  const [apiEndpoint, setApiEndpoint] = useState<string>('');
  const [responseFormat, setResponseFormat] = useState<'json' | 'xml'>('json');
  const [selectedServer, setSelectedServer] = useState<string>('');
  const [parameters, setParameters] = useState<QueryParameter[]>([{ key: '', value: '' }]);
  const [servers, setServers] = useState<Server[]>([]);
  const availableServers = useMemo(() => {
    const plexRemote: Server = {
      id: 'plex.tv',
      server_nickname: 'plex.tv (Remote)',
      service_type: 'plex',
      url: 'https://plex.tv'
    };

    const hasPlexRemote = servers.some((server) => server.id === plexRemote.id);
    return hasPlexRemote ? servers : [...servers, plexRemote];
  }, [servers]);
  const [protocol, setProtocol] = useState<'http' | 'https'>('https');
  const previousServerRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loggingSettings, setLoggingSettings] = useState<DebugLoggingSettings | null>(null);
  const [loggingLoading, setLoggingLoading] = useState(false);
  const [loggingSaving, setLoggingSaving] = useState(false);
  const [loggingDirty, setLoggingDirty] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'formatted' | 'raw' | 'headers' | 'curl'>('formatted');
  const [scrollAnchor, setScrollAnchor] = useState<'top' | 'bottom'>('top');
  const formattedRef = useRef<HTMLPreElement | null>(null);
  const rawRef = useRef<HTMLPreElement | null>(null);
  const headersRef = useRef<HTMLDivElement | null>(null);
  const curlRef = useRef<HTMLPreElement | null>(null);
  const { success, error: showError } = useAlerts();

  useEffect(() => {
    fetchServers();
    fetchLoggingSettings();
  }, []);

  useEffect(() => {
    if (!selectedServer) {
      return;
    }

    if (previousServerRef.current === selectedServer) {
      return;
    }

    const server = availableServers.find((s) => s.id === selectedServer);
    if (!server) {
      return;
    }

    const scheme = server.url.startsWith('http://') ? 'http' : server.url.startsWith('https://') ? 'https' : 'https';
    setProtocol(scheme);
    previousServerRef.current = selectedServer;
  }, [selectedServer, availableServers]);

  const buildBaseUrlWithProtocol = (url: string, scheme: 'http' | 'https'): string => {
    const trimmed = url.trim();
    const withoutProtocol = trimmed.replace(/^(https?:)?\/\//i, '');
    const combined = `${scheme}://${withoutProtocol}`;
    return combined.replace(/\/$/, '');
  };

  const fetchServers = async () => {
    try {
      const response = await requestJson<{ data: Server[] }>('/api/v2/servers');
      setServers(response.data || []);
    } catch (error) {
      showError('Failed to load servers: ' + String(error));
    }
  };

  const fetchLoggingSettings = async () => {
    setLoggingLoading(true);
    try {
      const response = await requestJson<{ data: DebugLoggingSettings }>('/api/v2/settings/debug-logging');
      setLoggingSettings(response.data);
      setLoggingDirty(false);
    } catch (err) {
      showError('Failed to load debug logging settings: ' + String(err));
    } finally {
      setLoggingLoading(false);
    }
  };

  const handleLoggingToggle = (key: keyof DebugLoggingSettings, value: boolean) => {
    if (!loggingSettings) {
      return;
    }

    setLoggingSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setLoggingDirty(true);
  };

  const handleLoggingSave = async () => {
    if (!loggingSettings || !loggingDirty) {
      return;
    }

    setLoggingSaving(true);
    try {
      await requestJson('/api/v2/settings/debug-logging', {
        method: 'PATCH',
        body: JSON.stringify(loggingSettings),
      });
      success('Debug logging settings updated');
      setLoggingDirty(false);
    } catch (err) {
      showError('Failed to update debug logging settings: ' + String(err));
    } finally {
      setLoggingSaving(false);
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
    const server = availableServers.find((s) => s.id === selectedServer);
    if (!server || !apiEndpoint) {
      return 'Select a server and enter an endpoint to see the full URL';
    }

    const baseUrl = buildBaseUrlWithProtocol(server.url, protocol);
    const endpoint = apiEndpoint.startsWith('/') ? apiEndpoint : '/' + apiEndpoint;

    const validParams = parameters.filter((p) => p.key && p.value);
    const queryString = validParams.length > 0
      ? '?' + validParams.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
      : '';

    return baseUrl + endpoint + queryString;
  };

  const executeRequest = async () => {
    if (!selectedServer || !apiEndpoint) {
      showError('Please select a server and enter an endpoint');
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);
    setActiveTab('formatted');

    try {
      const result = await requestJson<ApiResponse>('/api/v2/tools/api-debug/execute', {
        method: 'POST',
        body: JSON.stringify({
          method: httpMethod,
          endpoint: apiEndpoint,
          response_format: responseFormat,
          parameters: parameters.filter((p) => p.key && p.value),
          server_id: selectedServer,
          protocol,
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
      success('cURL command copied to clipboard');
    } catch {
      showError('Failed to copy to clipboard');
    }
  };

  const getStatusColor = (statusCode: number): string => {
    if (statusCode >= 200 && statusCode < 300) return 'text-green-500';
    if (statusCode >= 400) return 'text-destructive';
    return 'text-yellow-500';
  };

  const scrollToAnchor = useCallback(() => {
    if (!response) return;
    const target =
      activeTab === 'formatted'
        ? formattedRef.current
        : activeTab === 'raw'
          ? rawRef.current
          : activeTab === 'headers'
            ? headersRef.current
            : curlRef.current;

    if (!target) return;
    if (scrollAnchor === 'bottom') {
      target.scrollTop = target.scrollHeight;
    } else {
      target.scrollTop = 0;
    }
  }, [activeTab, scrollAnchor, response]);

  useEffect(() => {
    if (!response) return;
    const frame = window.requestAnimationFrame(scrollToAnchor);
    return () => window.cancelAnimationFrame(frame);
  }, [response, activeTab, scrollAnchor, scrollToAnchor]);

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
    <div className="space-y-6">
      <PageHeader
        title="API Debug"
        description="Test API endpoints for your configured media servers"
      />

      {/* Info Notice */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <FontAwesomeIcon icon={faCircleInfo} className="text-blue-500 text-xs" />
          </div>
          <div>
            <h4 className="font-medium text-blue-500 mb-1">Debug Tool</h4>
            <p className="text-sm text-foreground/80">
              This tool allows you to test API endpoints using the stored server credentials. All requests are authenticated automatically using your configured server settings.
            </p>
          </div>
        </div>
      </div>

      {/* API Testing Form */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <FontAwesomeIcon icon={faTerminal} className="text-blue-500 text-sm" />
            </div>
            <div>
              <CardTitle>API Request Builder</CardTitle>
              <CardDescription>Configure and execute API requests to your media servers</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
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
                  {availableServers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.server_nickname} ({server.service_type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Protocol Selection */}
            <div className="space-y-2">
              <Label htmlFor="protocol-select">Protocol</Label>
              <Select value={protocol} onValueChange={(value) => setProtocol(value as 'http' | 'https')}>
                <SelectTrigger id="protocol-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="https">https://</SelectItem>
                  <SelectItem value="http">http://</SelectItem>
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
                    <FontAwesomeIcon icon={faTrash} className="text-xs" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" size="sm" variant="outline" onClick={addParameter}>
              <FontAwesomeIcon icon={faPlus} className="mr-2" />
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
                  <Spinner className="h-4 w-4 mr-2" />
                  Executing...
                </>
              ) : (
                <>
                  <FontAwesomeIcon icon={faPlay} className="mr-2" />
                  Execute Request
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setScrollAnchor((prev) => (prev === 'top' ? 'bottom' : 'top'))}
              title={`Scroll response to ${scrollAnchor === 'top' ? 'top' : 'bottom'}`}
            >
              <FontAwesomeIcon icon={scrollAnchor === 'top' ? faArrowUp : faArrowDown} className="mr-2" />
              Scroll: {scrollAnchor === 'top' ? 'Top' : 'Bottom'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error Section */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive text-xs" />
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
                <FontAwesomeIcon icon={faClipboardList} className="text-green-500 text-sm" />
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
                <pre ref={formattedRef} className="bg-muted rounded-lg p-4 overflow-auto max-h-96 text-sm whitespace-pre-wrap">
                  {response.response_format === 'xml' && response.response_xml
                    ? formatXml(response.response_xml)
                    : response.response_json
                    ? formatJson(response.response_json)
                    : 'Response could not be formatted'}
                </pre>
              </TabsContent>

              {/* Raw Response */}
              <TabsContent value="raw">
                <pre ref={rawRef} className="bg-muted rounded-lg p-4 overflow-auto max-h-96 text-sm whitespace-pre-wrap">
                  {response.response_text || 'No response body received'}
                </pre>
              </TabsContent>

              {/* Headers */}
              <TabsContent value="headers">
                <div ref={headersRef} className="rounded-lg border shadow-sm overflow-auto max-h-96">
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
                <pre ref={curlRef} className="bg-muted rounded-lg p-4 overflow-auto text-sm whitespace-pre-wrap">
                  {generateCurlCommand()}
                </pre>
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={copyCurlCommand}>
                    <FontAwesomeIcon icon={faCopy} className="mr-2" />
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
              <FontAwesomeIcon icon={faLightbulb} className="text-yellow-500 text-sm" />
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
                <FontAwesomeIcon icon={faPlay} className="mr-1" />
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
                <FontAwesomeIcon icon={faCube} className="mr-1" />
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
                <FontAwesomeIcon icon={faPlayCircle} className="mr-1" />
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
                <FontAwesomeIcon icon={faBook} className="mr-1" />
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
                <FontAwesomeIcon icon={faHeadphones} className="mr-1" />
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
                <FontAwesomeIcon icon={faBookOpen} className="mr-1" />
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

      {/* Debug Logging */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
              <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-500 text-sm" />
            </div>
            <div>
              <CardTitle>Debug Logging</CardTitle>
              <CardDescription>Enable payload logging for troubleshooting integrations</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
            <AlertTitle>Performance Warning</AlertTitle>
            <AlertDescription>
              Enabling any of these logs writes raw payloads to disk and can impact performance. Logs are written under
              <span className="font-mono"> multimediausermanager/logs</span> while enabled.
            </AlertDescription>
          </Alert>

          {loggingLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading debug logging settings...
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">Plex HTTP logging</p>
                  <p className="text-xs text-muted-foreground">Logs Plex HTTP session payloads fetched after WS events.</p>
                </div>
                <Switch
                  checked={loggingSettings?.plex_http_log_enabled ?? false}
                  onCheckedChange={(checked) => handleLoggingToggle('plex_http_log_enabled', checked)}
                  disabled={!loggingSettings || loggingSaving}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">Plex WebSocket logging</p>
                  <p className="text-xs text-muted-foreground">Logs raw Plex WebSocket messages.</p>
                </div>
                <Switch
                  checked={loggingSettings?.plex_ws_log_enabled ?? false}
                  onCheckedChange={(checked) => handleLoggingToggle('plex_ws_log_enabled', checked)}
                  disabled={!loggingSettings || loggingSaving}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">Jellyfin WebSocket logging</p>
                  <p className="text-xs text-muted-foreground">Logs raw Jellyfin WebSocket session payloads.</p>
                </div>
                <Switch
                  checked={loggingSettings?.jellyfin_ws_log_enabled ?? false}
                  onCheckedChange={(checked) => handleLoggingToggle('jellyfin_ws_log_enabled', checked)}
                  disabled={!loggingSettings || loggingSaving}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">Emby WebSocket logging</p>
                  <p className="text-xs text-muted-foreground">Logs raw Emby WebSocket session payloads.</p>
                </div>
                <Switch
                  checked={loggingSettings?.emby_ws_log_enabled ?? false}
                  onCheckedChange={(checked) => handleLoggingToggle('emby_ws_log_enabled', checked)}
                  disabled={!loggingSettings || loggingSaving}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">AudiobookShelf HTTP logging</p>
                  <p className="text-xs text-muted-foreground">Logs AudiobookShelf HTTP session payloads.</p>
                </div>
                <Switch
                  checked={loggingSettings?.audiobookshelf_http_log_enabled ?? false}
                  onCheckedChange={(checked) => handleLoggingToggle('audiobookshelf_http_log_enabled', checked)}
                  disabled={!loggingSettings || loggingSaving}
                />
              </div>

              <div className="flex items-center justify-end gap-3">
                <Button
                  type="button"
                  onClick={handleLoggingSave}
                  disabled={!loggingDirty || loggingSaving || loggingLoading}
                >
                  {loggingSaving ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4 text-muted-foreground" />
                      Saving...
                    </>
                  ) : (
                    'Save Changes'
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminSettingsApiDebugPage;
