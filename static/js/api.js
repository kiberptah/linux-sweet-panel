function unauthorized() {
  window.dispatchEvent(new CustomEvent('lp:unauthorized'));
}

async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: { 'X-LP': '1' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    throw new Error('network error: ' + (err && err.message ? err.message : 'request failed'));
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (response.status === 401) {
    unauthorized();
    throw new Error((data && data.error) || 'not authenticated');
  }
  if (!response.ok) {
    throw new Error((data && data.error) || 'request failed (' + response.status + ')');
  }
  return data === null ? {} : data;
}

function put(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-LP', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = null;
      }
      if (xhr.status === 401) {
        unauthorized();
        reject(new Error((data && data.error) || 'not authenticated'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data || {});
        return;
      }
      reject(new Error((data && data.error) || 'upload failed (' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.onabort = () => reject(new Error('upload aborted'));
    xhr.send(blob);
  });
}

export const api = {
  get(path) {
    return request('GET', path);
  },
  post(path, body) {
    return request('POST', path, body === undefined ? {} : body);
  },
  put
};
