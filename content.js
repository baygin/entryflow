class EksiRealtimeMonitor {
  constructor() {
    this.currentEntryIds = new Set();
    this.topicUrl = null;
    this.baseParams = new URLSearchParams();
    this.currentPage = 1;
    this.totalPages = 1;
    this.isMonitoring = false;
    this.checkInterval = null;
    this.checkIntervalTime = 30000;
    this.countdownInterval = null;
    this.nextCheckTime = null;

    this.setupMessageListener();
    this.initialize();
  }

  async initialize() {
    await this.loadSettings();
    this.init();
  }

  async loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise((resolve) => {
        chrome.storage.sync.get(['checkInterval'], (result) => {
          if (result.checkInterval) {
            this.checkIntervalTime = result.checkInterval;
          }
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  setupMessageListener() {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateInterval') {
          this.checkIntervalTime = request.interval;

          if (chrome.storage) {
            chrome.storage.sync.set({ checkInterval: request.interval });
          }

          if (this.isMonitoring) {
            this.stopMonitoring();
            this.startMonitoring();
          }
        }
        return true;
      });
    }
  }

  init() {
    if (!this.isTopicPage()) {
      return;
    }

    this.extractTopicInfo();
    this.collectCurrentEntries();
    this.createControlPanel();
  }

  isTopicPage() {
    const path = window.location.pathname;
    const isMatch = path.match(/^\/[^\/]+--\d+/) !== null;
    return isMatch;
  }

  extractTopicInfo() {
    const pager = document.querySelector('.pager');
    if (pager) {
      this.currentPage = parseInt(pager.dataset.currentpage) || 1;
      this.totalPages = parseInt(pager.dataset.pagecount) || 1;
    }

    const titleElement = document.querySelector('#title');
    if (titleElement) {
      const slug = titleElement.dataset.slug;
      const id = titleElement.dataset.id;
      this.topicUrl = `/${slug}--${id}`;
    } else {
      this.topicUrl = window.location.pathname.split('?')[0];
    }

    const urlParams = new URLSearchParams(window.location.search);
    this.baseParams = new URLSearchParams();

    for (const [key, value] of urlParams) {
      if (key !== 'p') {
        this.baseParams.set(key, value);
      }
    }
  }

  collectCurrentEntries() {
    const entries = document.querySelectorAll('#entry-item-list li[data-id]');
    this.currentEntryIds.clear();

    entries.forEach(entry => {
      const entryId = entry.dataset.id;
      if (entryId) {
        this.currentEntryIds.add(entryId);
      }
    });
  }

  async fetchPage(pageNum = null) {
    const params = new URLSearchParams(this.baseParams);

    if (pageNum && pageNum > 1) {
      params.set('p', pageNum);
    }

    const paramString = params.toString();
    const url = paramString ? `${this.topicUrl}?${paramString}` : this.topicUrl;
    const fullUrl = `https://eksisozluk.com${url}`;

    try {
      const response = await fetch(fullUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const html = await response.text();
      return this.parseHTML(html);
    } catch (error) {
      this.showNotification('fetch hatası: ' + error.message);
      return null;
    }
  }

  parseHTML(htmlString) {
    const parser = new DOMParser();
    return parser.parseFromString(htmlString, 'text/html');
  }

  extractNewEntries(doc) {
    const entries = doc.querySelectorAll('#entry-item-list li[data-id]');
    const newEntries = [];

    entries.forEach(entry => {
      const entryId = entry.dataset.id;
      if (entryId && !this.currentEntryIds.has(entryId)) {
        newEntries.push({
          id: entryId,
          element: entry.cloneNode(true)
        });
      }
    });

    return newEntries;
  }

  getNextPageInfo(doc) {
    const pager = doc.querySelector('.pager');
    if (pager) {
      const currentPage = parseInt(pager.dataset.currentpage) || 1;
      const totalPages = parseInt(pager.dataset.pagecount) || 1;
      return { currentPage, totalPages };
    }
    return null;
  }

  async checkForNewEntries(forceCheck = false) {
    if (!forceCheck && !this.isMonitoring) {
      return;
    }

    this.setUpdateStatus('güncelleniyor...', 'checking');

    let allNewEntries = [];

    const lastPageDoc = await this.fetchPage(this.totalPages);

    if (lastPageDoc) {
      const pageInfo = this.getNextPageInfo(lastPageDoc);

      if (pageInfo) {
        if (pageInfo.totalPages > this.totalPages) {
          for (let page = this.totalPages; page <= pageInfo.totalPages; page++) {
            const pageDoc = await this.fetchPage(page);
            if (pageDoc) {
              const pageEntries = this.extractNewEntries(pageDoc);
              allNewEntries = allNewEntries.concat(pageEntries);
            }
          }

          this.totalPages = pageInfo.totalPages;
        } else {
          const newEntries = this.extractNewEntries(lastPageDoc);
          allNewEntries = allNewEntries.concat(newEntries);
        }
      }
    }

    if (allNewEntries.length > 0) {
      this.addNewEntries(allNewEntries);
      this.setUpdateStatus(`${allNewEntries.length} yeni entry bulundu`, 'success');
    } else {
      this.setUpdateStatus('yeni entry yok', 'success');
    }

    if (this.isMonitoring) {
      this.startCountdown();
    }
  }

  addNewEntries(newEntries) {
    const entryList = document.querySelector('#entry-item-list');
    if (!entryList) {
      return;
    }

    newEntries.sort((a, b) => parseInt(a.id) - parseInt(b.id));

    let lastAddedEntry = null;

    newEntries.forEach(({ id, element }) => {
      element.classList.add('realtime-new-entry');
      entryList.appendChild(element);
      this.currentEntryIds.add(id);
      lastAddedEntry = element;
    });

    if (lastAddedEntry) {
      lastAddedEntry.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });

      setTimeout(() => {
        lastAddedEntry.classList.add('realtime-highlight');
      }, 500);

      setTimeout(() => {
        lastAddedEntry.classList.remove('realtime-highlight');
      }, 3000);
    }

    this.updateEntryCount();
    this.showNotification(`${newEntries.length} yeni entry eklendi`);
  }

  createControlPanel() {
    const panel = document.createElement('div');
    panel.id = 'realtime-control-panel';
    panel.innerHTML = `
      <div class="realtime-panel-header">
        <span class="realtime-panel-title">⚡ entryflow</span>
        <button id="realtime-minimize" class="realtime-minimize-btn" title="gizle/göster">−</button>
      </div>
      <div class="realtime-panel-content">
        <button id="realtime-toggle" class="realtime-btn">
          <span class="realtime-status">⏸</span>
          <span class="realtime-text">otomatik güncelleme</span>
        </button>
        <button id="realtime-refresh" class="realtime-btn">
          <span>🔄</span>
          <span>şimdi kontrol et</span>
        </button>
        <div class="realtime-interval-control">
          <label for="realtime-interval-input">güncelleme süresi (sn):</label>
          <input type="number" id="realtime-interval-input" min="10" max="300" value="${this.checkIntervalTime / 1000}" />
        </div>
        <div class="realtime-status-info">
          <div id="realtime-countdown" class="realtime-countdown"></div>
          <div id="realtime-update-status" class="realtime-update-status"></div>
        </div>
        <div class="realtime-info">
          <span id="realtime-entry-count">${this.currentEntryIds.size} entry</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const toggleBtn = document.getElementById('realtime-toggle');
    const refreshBtn = document.getElementById('realtime-refresh');
    const minimizeBtn = document.getElementById('realtime-minimize');
    const intervalInput = document.getElementById('realtime-interval-input');
    const panelContent = panel.querySelector('.realtime-panel-content');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.toggleMonitoring();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.checkForNewEntries(true);
      });
    }

    if (intervalInput) {
      intervalInput.addEventListener('change', (e) => {
        this.updateCheckInterval(parseInt(e.target.value));
      });
    }

    if (minimizeBtn && panelContent) {
      minimizeBtn.addEventListener('click', () => {
        const isMinimized = panel.classList.toggle('minimized');
        minimizeBtn.textContent = isMinimized ? '+' : '−';
      });
    }
  }

  updateCheckInterval(intervalSeconds) {
    if (intervalSeconds < 10 || intervalSeconds > 300) {
      this.showNotification('güncelleme süresi 10-300 saniye arasında olmalıdır');

      const intervalInput = document.getElementById('realtime-interval-input');
      if (intervalInput) {
        intervalInput.value = this.checkIntervalTime / 1000;
      }
      return;
    }

    const intervalMs = intervalSeconds * 1000;
    this.checkIntervalTime = intervalMs;

    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.set({ checkInterval: intervalMs });
    }

    if (this.isMonitoring) {
      this.stopMonitoring();
      this.startMonitoring();
    }

    this.showNotification(`güncelleme süresi ${intervalSeconds} saniye olarak ayarlandı`);
  }

  toggleMonitoring() {
    this.isMonitoring = !this.isMonitoring;

    const toggleBtn = document.getElementById('realtime-toggle');
    const statusIcon = toggleBtn.querySelector('.realtime-status');

    if (this.isMonitoring) {
      statusIcon.textContent = '▶';
      toggleBtn.classList.add('active');
      this.startMonitoring();
      this.showNotification('Otomatik güncelleme başlatıldı');
    } else {
      statusIcon.textContent = '⏸';
      toggleBtn.classList.remove('active');
      this.stopMonitoring();
      this.showNotification('Otomatik güncelleme durduruldu');
    }
  }

  startCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }

    this.nextCheckTime = Date.now() + this.checkIntervalTime;

    this.countdownInterval = setInterval(() => {
      const remainingMs = this.nextCheckTime - Date.now();

      if (remainingMs <= 0) {
        this.updateCountdownDisplay(0);
        return;
      }

      const remainingSeconds = Math.ceil(remainingMs / 1000);
      this.updateCountdownDisplay(remainingSeconds);
    }, 1000);

    this.updateCountdownDisplay(Math.ceil(this.checkIntervalTime / 1000));
  }

  updateCountdownDisplay(seconds) {
    const countdownElement = document.getElementById('realtime-countdown');
    if (countdownElement) {
      if (seconds > 0) {
        countdownElement.textContent = `sonraki güncelleme: ${seconds} saniye`;
      } else {
        countdownElement.textContent = '';
      }
    }
  }

  stopCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    const countdownElement = document.getElementById('realtime-countdown');
    if (countdownElement) {
      countdownElement.textContent = '';
    }
  }

  setUpdateStatus(status, type = 'info') {
    const statusElement = document.getElementById('realtime-update-status');
    if (statusElement) {
      statusElement.textContent = status;
      statusElement.className = `realtime-update-status ${type}`;

      if (type === 'success') {
        setTimeout(() => {
          statusElement.textContent = '';
          statusElement.className = 'realtime-update-status';
        }, 2000);
      }
    }
  }

  startMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkForNewEntries();
    }, this.checkIntervalTime);

    this.checkForNewEntries();
    this.startCountdown();
  }

  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.stopCountdown();
  }

  showNotification(message) {
    const existing = document.querySelector('.realtime-notification');
    if (existing) {
      existing.remove();
    }

    const notification = document.createElement('div');
    notification.className = 'realtime-notification';
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('show');
    }, 10);

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  updateEntryCount() {
    const countElement = document.getElementById('realtime-entry-count');
    if (countElement) {
      countElement.textContent = `${this.currentEntryIds.size} entry`;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new EksiRealtimeMonitor();
  });
} else {
  new EksiRealtimeMonitor();
}
