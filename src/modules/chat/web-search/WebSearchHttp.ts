export interface HttpResponse {
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  body: string;
}

interface RequestOptions {
  timeoutMs: number;
  method?: "GET" | "HEAD";
  accept?: string;
}

export function requestHttp(
  url: string,
  {
    timeoutMs,
    method = "GET",
    accept = "application/json,text/plain,*/*",
  }: RequestOptions,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timeoutTriggered = false;

    xhr.open(method, url, true);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Accept", accept);

    xhr.onload = () => {
      const contentLengthHeader = xhr.getResponseHeader("Content-Length");
      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        contentType: xhr.getResponseHeader("Content-Type") || "",
        contentLength: contentLengthHeader
          ? Number.parseInt(contentLengthHeader, 10)
          : undefined,
        body: xhr.responseText || "",
      });
    };

    xhr.onerror = () => {
      reject(new Error(`Request failed for ${url}`));
    };

    xhr.ontimeout = () => {
      timeoutTriggered = true;
      xhr.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    };

    xhr.onabort = () => {
      if (timeoutTriggered) {
        return;
      }
      reject(new Error(`Request aborted: ${url}`));
    };

    xhr.send();
  });
}

export async function requestJson<T>(
  url: string,
  timeoutMs: number,
): Promise<T> {
  const response = await requestHttp(url, {
    timeoutMs,
    accept: "application/json,text/plain,*/*",
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Request failed: ${response.status} ${response.statusText} (${url})`,
    );
  }

  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}
