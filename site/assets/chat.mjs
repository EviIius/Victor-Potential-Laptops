// Chat text is always rendered as text. Source cards come from the site's own catalog.
export function createChat({ endpoint, getContext, sourceCard }) {
  const root = document.querySelector('#chat-app');
  let history = []; let controller = null;
  const $ = s => root.querySelector(s);
  let access = '';
  try { access = sessionStorage.getItem('vlf:chatAccess') || ''; } catch { /* session storage unavailable */ }
  const connected = (() => {
    try { const url = new URL(endpoint); return url.protocol === 'https:' && url.pathname === '/chat' && !url.username && !url.password; }
    catch { return false; }
  })();
  root.innerHTML = `
    <div class="chat-context panel"><p class="eyebrow">YOUR LISTINGS. YOUR PRIORITIES.</p><p id="chat-scope"></p><p class="hint">Scores are estimates. Snapshot and user-reported prices still need a retailer check.</p></div>
    <div class="panel chat-shell">
      <div class="chat-toolbar"><h3>A second opinion for Victor</h3><button class="btn btn-sm" id="chat-clear" type="button">New chat</button></div>
      <p class="sub" id="chat-connection"></p>
      <details id="chat-access" ${!access && connected ? 'open' : ''} ${!connected ? 'hidden' : ''}>
        <summary>Chat access code</summary>
        <label for="chat-code">Enter the code Jake shared with you</label>
        <div class="chat-code-row"><input id="chat-code" type="password" autocomplete="off" maxlength="512" placeholder="Chat access code"><button class="btn btn-sm" id="chat-forget" type="button">Forget code</button></div>
        <p class="hint">Kept in this tab for this session.</p>
      </details>
      <div class="chat-suggestions" role="group" aria-label="Example questions">
        <button class="btn btn-sm" type="button" data-question="Which three laptops best fit my budget and priorities? Explain the trade-offs and price uncertainty.">Best fits for me</button>
        <button class="btn btn-sm" type="button" data-question="Compare the two laptops in my A/B comparison. Is the more expensive one worth it for my priorities?">Explain my A/B comparison</button>
        <button class="btn btn-sm" type="button" data-question="Which laptops with recently confirmed retailer prices should I consider within my budget?">Options with confirmed quotes</button>
      </div>
      <div id="chat-messages" class="chat-messages" role="log" aria-label="Conversation with Gemini" aria-live="polite" aria-relevant="additions"></div>
      <form id="chat-form" class="chat-form">
        <label for="chat-question">Ask about the laptops</label>
        <textarea id="chat-question" rows="3" maxlength="1600" placeholder="Is a 5070 Ti worth it over a 5060 for me?" required></textarea>
        <div class="chat-form-foot"><span class="hint">Up to 1,600 characters · Enter to send, Shift+Enter for a new line</span><div><button class="btn" id="chat-cancel" type="button" hidden>Cancel</button><button class="btn btn-accent" id="chat-send" type="submit">Ask Gemini ↗</button></div></div>
      </form>
      <p id="chat-status" class="chat-status" role="status"></p>
      <p class="hint chat-privacy">Your question, recent chat, priorities and laptop data are sent to Google. Gemini can make mistakes. Google may use free-tier conversations to improve its products. Don’t include personal information.</p>
    </div>`;
  $('#chat-code').value = access;
  $('#chat-connection').textContent = connected ? 'Answers use the full catalog, including laptops hidden by your browsing filters.' : 'Gemini is not connected yet. Jake needs to finish the account and API-key setup.';
  $('#chat-question').disabled = !connected;
  $('#chat-send').disabled = !connected;
  root.querySelectorAll('[data-question]').forEach(b => {
    b.disabled = !connected;
    b.addEventListener('click', () => prefill(b.dataset.question));
  });
  function refresh() {
    const c = getContext();
    $('#chat-scope').textContent = `${c.count} configurations · Budget $${c.preferences.budget.toLocaleString('en-US')} · ${c.summary}`;
  }
  function prefill(question) {
    $('#chat-question').value = question.slice(0, 1600);
    if (connected) $('#chat-question').focus();
  }
  function message(role, text, ids = [], result = null) {
    const article = document.createElement('article');
    article.className = `chat-message chat-${role}`;
    const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = role === 'user' ? 'VICTOR' : 'GEMINI';
    const body = document.createElement('div'); body.className = 'chat-text'; body.textContent = text;
    article.append(label, body);
    if (result) {
      const stamp = document.createElement('p'); stamp.className = 'hint';
      stamp.textContent = `Answered with your priorities and $${result.budget.toLocaleString('en-US')} budget at the time of this question.`;
      article.append(stamp);
    }
    const cards = document.createElement('div'); cards.className = 'chat-sources';
    for (const id of [...new Set(ids)].slice(0, 4)) {
      const html = sourceCard(id); if (!html) continue;
      const card = document.createElement('div'); card.innerHTML = html; cards.append(card);
    }
    if (cards.children.length) {
      const caption = document.createElement('p'); caption.className = 'hint';
      caption.textContent = result?.catalog_generated_at !== getContext().catalog_generated_at ? 'Source cards use this page’s loaded catalog; Gemini used a newer or older catalog. Reload for the latest listings.' : 'Source configurations and scores from the catalog:';
      article.append(caption, cards);
    }
    $('#chat-messages').append(article);
  }
  function busy(value) {
    $('#chat-send').disabled = value || !connected;
    $('#chat-cancel').hidden = !value;
    $('#chat-question').readOnly = value;
    $('#chat-messages').setAttribute('aria-busy', value ? 'true' : 'false');
    root.querySelectorAll('[data-question]').forEach(b => { b.disabled = value || !connected; });
  }
  $('#chat-code').addEventListener('input', () => {
    access = $('#chat-code').value.trim();
    try { sessionStorage.setItem('vlf:chatAccess', access); } catch { /* session storage unavailable */ }
  });
  $('#chat-forget').addEventListener('click', () => {
    access = ''; $('#chat-code').value = '';
    try { sessionStorage.removeItem('vlf:chatAccess'); } catch { /* ignore */ }
    $('#chat-access').open = true; $('#chat-code').focus();
  });
  $('#chat-cancel').addEventListener('click', () => controller?.abort());
  $('#chat-clear').addEventListener('click', () => {
    controller?.abort(); history = []; $('#chat-messages').replaceChildren();
    $('#chat-status').textContent = ''; $('#chat-question').value = '';
    if (connected) $('#chat-question').focus();
  });
  $('#chat-question').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#chat-form').addEventListener('submit', async e => {
    e.preventDefault(); if (controller || !connected) return;
    const question = $('#chat-question').value.trim(); if (!question) return;
    if (access.length < 16) { $('#chat-status').textContent = 'Enter the chat access code from Jake first.'; $('#chat-access').open = true; $('#chat-code').focus(); return; }
    const context = getContext();
    const payload = { message: question, preferences: context.preferences, compare: context.compare, history: history.slice(-6) };
    while (new TextEncoder().encode(JSON.stringify(payload)).length > 16000 && payload.history.length) payload.history.splice(0, 2);
    const current = new AbortController(); controller = current; busy(true);
    const timeout = setTimeout(() => current.abort('timeout'), 55000);
    message('user', question);
    $('#chat-status').textContent = 'Gemini is reading the listings and your scores…';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: JSON.stringify(payload), signal: current.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) { $('#chat-access').open = true; $('#chat-code').focus(); }
        throw new Error(typeof result.error === 'string' ? result.error.slice(0, 500) : 'Chat could not answer. Try again later.');
      }
      if (typeof result.answer !== 'string' || !Array.isArray(result.laptop_ids)) throw new Error('Chat returned an unreadable answer. Please try again.');
      message('model', result.answer, result.laptop_ids, { ...result, budget: context.preferences.budget });
      history.push({ role: 'user', text: question }, { role: 'model', text: result.answer });
      history = history.slice(-6);
      $('#chat-question').value = ''; $('#chat-access').open = false;
      $('#chat-status').textContent = 'Answer ready. You can ask a follow-up.';
    } catch (error) {
      $('#chat-status').textContent = current.signal.aborted ? (current.signal.reason === 'timeout' ? 'The answer took too long. Try again.' : 'Question cancelled.') : error instanceof TypeError ? 'Could not reach chat. Check your connection and try again.' : error.message;
    } finally {
      clearTimeout(timeout); controller = null; busy(false);
    }
  });
  refresh();
  return { refresh, prefill };
}
