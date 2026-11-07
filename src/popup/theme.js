/* Applies the chosen theme before the first paint (chrome.storage is asynchronous; the choice is mirrored here). */
try { const t = localStorage.getItem('ap-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* no storage */ }
