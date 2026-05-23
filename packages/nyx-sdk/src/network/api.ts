export class NyxApiClient {
  private baseURL: string;
  private apiKey: string;
  private token: string | null = null;

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  public setToken(token: string): void {
    this.token = token;
  }

  public async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    
    const headers = new Headers(options.headers);
    
    // Add required headers
    headers.set('x-nyx-engine-key', this.apiKey);
    
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    
    // Set default Content-Type if body is present and not FormData
    if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const config: RequestInit = {
      ...options,
      headers,
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      let errorMessage = `HTTP Error ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData && errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData && errorData.message) {
          errorMessage = errorData.message;
        }
      } catch (e) {
        // Ignore JSON parsing errors for error responses
      }
      throw new Error(errorMessage);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }

    return response.text() as unknown as T;
  }
}
