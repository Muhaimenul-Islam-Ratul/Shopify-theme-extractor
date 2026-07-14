// Global state initialized on window
if (!window.__shopifyThemeExporterState) {
  window.__shopifyThemeExporterState = {
    status: 'idle', // 'idle', 'scanning', 'fetching_assets', 'downloading', 'zipping', 'completed', 'error'
    themes: [],
    themeId: null,
    downloaded: 0,
    total: 0,
    error: null,
    apiBase: '',
    storeName: ''
  };
}

// Extract store name and base path for Admin endpoints from URL
function getStoreInfo() {
  const url = window.location.href;
  let apiBase = '';
  let storeName = '';
  
  if (window.location.hostname === 'admin.shopify.com') {
    const match = url.match(/https:\/\/admin\.shopify\.com\/store\/([^/]+)/);
    if (match) {
      storeName = match[1];
      apiBase = `/store/${storeName}/api/unstable`;
    }
  } else if (window.location.hostname.endsWith('.myshopify.com')) {
    storeName = window.location.hostname.split('.')[0];
    apiBase = `/admin/api/unstable`;
  }
  return { storeName, apiBase };
}

// Broadcast state update to popup script
function broadcastProgress() {
  chrome.runtime.sendMessage({
    action: 'PROGRESS_UPDATE',
    state: window.__shopifyThemeExporterState
  }, () => {
    // Suppress console error if popup is closed and channel is cut
    const err = chrome.runtime.lastError;
  });
}

// Resilient API fetching with linear retry backoff and 429 support
async function fetchWithRetry(url, options = {}, retries = 5, backoff = 1000) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;
      console.warn(`[ThemeExporter] Rate limit hit (429). Retrying after ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchWithRetry(url, options, retries - 1, backoff * 1.5);
    }
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    return res;
  } catch (error) {
    if (retries > 0) {
      console.warn(`[ThemeExporter] Request failed: ${error.message}. Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      return fetchWithRetry(url, options, retries - 1, backoff * 1.5);
    }
    throw error;
  }
}

// Scan the store for available themes
async function scanThemes() {
  const state = window.__shopifyThemeExporterState;
  
  // Return early if actively downloading
  if (state.status === 'fetching_assets' || state.status === 'downloading' || state.status === 'zipping') {
    return state.themes;
  }
  
  state.status = 'scanning';
  state.error = null;
  broadcastProgress();
  
  try {
    const { storeName, apiBase } = getStoreInfo();
    if (!storeName || !apiBase) {
      throw new Error('Not on a Shopify Admin page or Store name not detected.');
    }
    state.storeName = storeName;
    state.apiBase = apiBase;
    
    const response = await fetchWithRetry(`${apiBase}/themes.json`);
    const data = await response.json();
    
    state.themes = data.themes || [];
    state.status = 'idle';
    state.error = null;
    broadcastProgress();
    return state.themes;
  } catch (err) {
    state.status = 'error';
    state.error = `Failed to scan themes: ${err.message}`;
    broadcastProgress();
    throw err;
  }
}

// Pull all assets for selected theme and zip download
async function startExport(themeId) {
  const state = window.__shopifyThemeExporterState;
  if (state.status === 'fetching_assets' || state.status === 'downloading' || state.status === 'zipping') {
    console.warn('[ThemeExporter] Export already in progress.');
    return;
  }
  
  state.status = 'fetching_assets';
  state.themeId = themeId;
  state.downloaded = 0;
  state.total = 0;
  state.error = null;
  broadcastProgress();
  
  try {
    const { storeName, apiBase } = getStoreInfo();
    if (!storeName || !apiBase) {
      throw new Error('Store context lost. Please refresh the page.');
    }
    
    // Step 1: Get list of all assets
    const response = await fetchWithRetry(`${apiBase}/themes/${themeId}/assets.json`);
    const data = await response.json();
    
    const assets = data.assets || [];
    if (assets.length === 0) {
      throw new Error('No assets found in this theme.');
    }
    
    state.status = 'downloading';
    state.total = assets.length;
    broadcastProgress();
    
    // Step 2: Download each asset contents and add to JSZip
    const zip = new JSZip();
    let currentIndex = 0;
    const concurrency = 4; // Concurrent requests pool
    
    async function downloadWorker() {
      while (currentIndex < assets.length && state.status === 'downloading') {
        const index = currentIndex++;
        const asset = assets[index];
        try {
          const assetRes = await fetchWithRetry(`${apiBase}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`);
          const assetData = (await assetRes.json()).asset;
          
          if (assetData.value !== undefined && assetData.value !== null) {
            zip.file(asset.key, assetData.value);
          } else if (assetData.attachment !== undefined && assetData.attachment !== null) {
            zip.file(asset.key, assetData.attachment, { base64: true });
          }
          
          state.downloaded++;
          broadcastProgress();
        } catch (err) {
          console.error(`[ThemeExporter] Failed to download asset ${asset.key}:`, err);
          // Still increment count so we don't block progress completely
          state.downloaded++;
          broadcastProgress();
        }
        // Small delay between requests to throttle load
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    }
    
    // Run concurrent workers
    const workers = Array.from({ length: concurrency }, () => downloadWorker());
    await Promise.all(workers);
    
    if (state.status !== 'downloading') {
      throw new Error('Export aborted or failed.');
    }
    
    // Step 3: Bundle and trigger save
    state.status = 'zipping';
    broadcastProgress();
    
    const blob = await zip.generateAsync({ type: 'blob' });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${storeName}-theme-${themeId}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    state.status = 'completed';
    broadcastProgress();
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    broadcastProgress();
  }
}

// Messaging receiver
if (!window.__shopifyThemeExporterListenerRegistered) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const state = window.__shopifyThemeExporterState;
    
    if (message.action === 'PING') {
      sendResponse({ status: 'pong' });
    } else if (message.action === 'GET_STATE') {
      sendResponse({ state });
    } else if (message.action === 'SCAN_THEMES') {
      scanThemes()
        .then(themes => sendResponse({ success: true, themes }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response
    } else if (message.action === 'START_EXPORT') {
      startExport(message.themeId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response
    }
  });
  
  window.__shopifyThemeExporterListenerRegistered = true;
  console.log('[ThemeExporter] Injected listener successfully.');
}
