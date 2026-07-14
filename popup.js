// DOM Elements
const themeSelect = document.getElementById('themeSelect');
const loadThemesBtn = document.getElementById('loadThemesBtn');
const loadThemesSpinner = document.getElementById('loadThemesSpinner');
const loadContent = document.getElementById('loadContent');
const loadThemesText = document.getElementById('loadThemesText');

const exportBtn = document.getElementById('exportBtn');
const btnSpinner = document.getElementById('btnSpinner');
const exportContent = document.getElementById('exportContent');
const btnText = document.getElementById('btnText');

const progressContainer = document.getElementById('progressContainer');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const progressBar = document.getElementById('progressBar');

const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');

let activeTabId = null;

// Initialize popup
async function init() {
  try {
    // 1. Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showError('No active tab detected.');
      return;
    }
    
    activeTabId = tab.id;
    const url = tab.url;
    
    // 2. Validate it's a Shopify Admin page
    if (!isShopifyAdmin(url)) {
      showError('Please open a Shopify Admin tab (e.g., admin.shopify.com/store/... or myshopify.com/admin) to scan themes.');
      themeSelect.innerHTML = '<option value="" disabled selected>No Shopify Store Active</option>';
      themeSelect.disabled = true;
      return;
    }
    
    // 3. Ensure content scripts are injected
    themeSelect.innerHTML = '<option value="" disabled selected>Connecting to page...</option>';
    await ensureContentScript(activeTabId);
    
    // 4. Listen for progress updates from the content script
    chrome.runtime.onMessage.addListener(handleRuntimeMessages);
    
    // 5. Query initial state from tab
    chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) {
        showError('Failed to communicate with tab. Please reload the page.');
        return;
      }
      
      if (response && response.state) {
        const state = response.state;
        renderState(state);
        
        // If state is idle and no themes scanned yet, scan automatically
        if (state.status === 'idle' && state.themes.length === 0) {
          triggerScan();
        }
      }
    });
    
  } catch (err) {
    showError(err.message);
  }
}

// Check if tab URL matches Shopify Admin patterns
function isShopifyAdmin(url) {
  if (!url) return false;
  return url.includes('admin.shopify.com/store/') || url.includes('.myshopify.com/admin');
}

// Injects JSZip and content.js dynamically if not already present
function ensureContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'PING' }, (response) => {
      // If PING succeeds, content script is already there
      if (chrome.runtime.lastError || !response || response.status !== 'pong') {
        // Step 1: Inject JSZip
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['jszip.min.js']
        }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(`Failed to inject JSZip: ${chrome.runtime.lastError.message}`));
            return;
          }
          
          // Step 2: Inject content.js
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(`Failed to inject Theme Exporter: ${chrome.runtime.lastError.message}`));
            } else {
              resolve();
            }
          });
        });
      } else {
        resolve();
      }
    });
  });
}

// Handle progress broadcasts
function handleRuntimeMessages(message) {
  if (message.action === 'PROGRESS_UPDATE' && message.state) {
    renderState(message.state);
  }
}

// Toggle loading state on button
function setButtonLoading(btnEl, spinnerEl, contentEl, isLoading) {
  if (isLoading) {
    btnEl.disabled = true;
    spinnerEl.style.display = 'block';
    contentEl.style.opacity = '0';
  } else {
    btnEl.disabled = false;
    spinnerEl.style.display = 'none';
    contentEl.style.opacity = '1';
  }
}

// Render popup UI based on content script state
function renderState(state) {
  // If scanning themes
  if (state.status === 'scanning') {
    themeSelect.disabled = true;
    themeSelect.innerHTML = '<option value="" disabled selected>Scanning themes...</option>';
    setButtonLoading(loadThemesBtn, loadThemesSpinner, loadContent, true);
    setButtonLoading(exportBtn, btnSpinner, exportContent, true);
    progressContainer.style.display = 'none';
    hideStatus();
    return;
  }
  
  // Reset scan button
  setButtonLoading(loadThemesBtn, loadThemesSpinner, loadContent, false);
  loadThemesBtn.style.display = 'none'; // Keep scan button hidden as dropdown has scanned themes
  
  // Populate themes dropdown if empty
  if (state.themes && state.themes.length > 0) {
    const currentVal = themeSelect.value;
    // Check if dropdown options match the state themes
    const existingIds = Array.from(themeSelect.options).map(o => o.value);
    const stateIds = state.themes.map(t => String(t.id));
    
    const mismatch = existingIds.length !== stateIds.length || !existingIds.every((id, i) => id === stateIds[i]);
    
    if (mismatch) {
      themeSelect.innerHTML = '';
      state.themes.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        const isPublished = t.role === 'main';
        option.textContent = t.name + (isPublished ? ' (Published)' : '');
        if (isPublished && !currentVal) {
          option.selected = true;
        }
        themeSelect.appendChild(option);
      });
    }
  }

  // Handle active states
  if (state.status === 'idle') {
    themeSelect.disabled = false;
    setButtonLoading(exportBtn, btnSpinner, exportContent, false);
    progressContainer.style.display = 'none';
  } 
  else if (state.status === 'fetching_assets') {
    themeSelect.disabled = true;
    setButtonLoading(exportBtn, btnSpinner, exportContent, true);
    
    progressContainer.style.display = 'block';
    progressText.textContent = 'Reading theme files directory...';
    progressPercent.textContent = '0%';
    progressBar.style.width = '0%';
    hideStatus();
  } 
  else if (state.status === 'downloading') {
    themeSelect.disabled = true;
    setButtonLoading(exportBtn, btnSpinner, exportContent, true);
    
    progressContainer.style.display = 'block';
    progressText.textContent = `Downloaded ${state.downloaded} / ${state.total} files...`;
    const percent = state.total > 0 ? Math.round((state.downloaded / state.total) * 100) : 0;
    progressPercent.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
  } 
  else if (state.status === 'zipping') {
    themeSelect.disabled = true;
    setButtonLoading(exportBtn, btnSpinner, exportContent, true);
    
    progressContainer.style.display = 'block';
    progressText.textContent = 'Compiling ZIP archive...';
    progressPercent.textContent = '99%';
    progressBar.style.width = '99%';
  } 
  else if (state.status === 'completed') {
    themeSelect.disabled = false;
    setButtonLoading(exportBtn, btnSpinner, exportContent, false);
    progressContainer.style.display = 'none';
    showSuccess('Themes Extracted');
  } 
  else if (state.status === 'error') {
    themeSelect.disabled = false;
    setButtonLoading(exportBtn, btnSpinner, exportContent, false);
    progressContainer.style.display = 'none';
    showError(state.error || 'Extraction failed');
  }
}

// Trigger scan for themes in current tab
function triggerScan() {
  if (!activeTabId) return;
  
  chrome.tabs.sendMessage(activeTabId, { action: 'SCAN_THEMES' }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Failed to fetch themes from store.');
      return;
    }
    
    if (response && !response.success) {
      showError(response.error);
    }
  });
}

// Trigger export for selected theme
function triggerExport() {
  if (!activeTabId) return;
  const themeId = themeSelect.value;
  if (!themeId) {
    showError('No theme selected.');
    return;
  }
  
  chrome.tabs.sendMessage(activeTabId, { action: 'START_EXPORT', themeId }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Connection error. Failed to initiate export.');
      return;
    }
    if (response && !response.success) {
      showError(response.error);
    }
  });
}

// Helper to show success messages
function showSuccess(msg) {
  statusDiv.style.display = 'flex';
  statusDiv.className = 'status-msg success';
  statusText.textContent = msg;
  setTimeout(() => {
    statusDiv.style.opacity = '1';
  }, 10);
}

// Helper to show error messages
function showError(msg) {
  statusDiv.style.display = 'flex';
  statusDiv.className = 'status-msg error';
  statusText.textContent = msg;
  setTimeout(() => {
    statusDiv.style.opacity = '1';
  }, 10);
}

// Helper to hide status message
function hideStatus() {
  statusDiv.style.opacity = '0';
  setTimeout(() => {
    if (statusDiv.style.opacity === '0') {
      statusDiv.style.display = 'none';
    }
  }, 300);
}

// Event Listeners
loadThemesBtn.addEventListener('click', triggerScan);
exportBtn.addEventListener('click', triggerExport);

// Run init on popup open
document.addEventListener('DOMContentLoaded', init);
