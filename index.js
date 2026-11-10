// 🎨 Иллюстратор сцен NovelAI — Отдельное расширение для SillyTavern
(function () {
    'use strict';

    const MODULE = 'nai_scene_illustrator';

    const DEFAULT_NAI_WRITER_PROMPT = `Пиши промпт для NovelAI на английском языке (сочетание точных тегов в духе Danbooru и краткого визуального описания сцены).
Строго соблюдай правильную анатомию и композицию:
— Всегда начинай с точного количества и пола персонажей в кадре (например: 1girl, 1boy или 2girls, 1boy).
— Прописывай естественные, анатомически правильные позы и пропорции тела (natural body proportions, anatomically correct hands and fingers, natural posture).
— Чётко указывай, где находятся руки и кисти каждого персонажа (например: hands resting on table, holding a cup, hand on shoulder), избегай сложных переплетений пальцев, вывернутых суставов и слияния тел.
— Чётко разделяй внешность и одежду каждого персонажа, чтобы их черты не смешивались.`;

    const defaults = {
        enabled: true,
        naiApiKey: '',
        naiModel: 'nai-diffusion-5-full-medium',
        naiSampler: 'k_euler_ancestral',
        naiScheduler: 'karras',
        naiSteps: 28,
        naiScale: 5.0,
        naiRescale: 0,
        naiCharRefMode: 'char_no_style',
        naiPrefix: '',
        naiNegative: 'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, negative space, blank page, bad anatomy, bad hands, text, watermark, signature',
        imgOrientation: 'portrait',
        sceneCameraMode: 'ask',
        imgPromptSource: '',
        imgPromptApiBase: 'https://open.bigmodel.cn/api/paas/v4',
        imgPromptApiKey: '',
        imgPromptApiModel: 'glm-4-plus',
        imgPromptWriterNote: DEFAULT_NAI_WRITER_PROMPT,
        contextMsgs: 15,
    };

    const ctx = () => SillyTavern.getContext();

    function settings() {
        const all = ctx().extensionSettings;
        if (!all[MODULE]) all[MODULE] = structuredClone(defaults);
        for (const k of Object.keys(defaults)) {
            if (all[MODULE][k] === undefined) all[MODULE][k] = defaults[k];
        }
        return all[MODULE];
    }

    function saveSettings() {
        ctx().saveSettingsDebounced();
    }

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function withTimeout(promise, ms, what) {
        let t;
        return Promise.race([
            promise,
            new Promise((_, rej) => {
                t = setTimeout(() => rej(new Error(`${what}: нет ответа ${Math.round(ms / 1000)} сек.`)), ms);
            }),
        ]).finally(() => clearTimeout(t));
    }

    function connectionProfiles() {
        return ctx().extensionSettings?.connectionManager?.profiles || [];
    }

    function storyNames() {
        const c = ctx();
        const user = c.name1 || 'Героиня';
        const char = c.name2 || 'Персонаж';
        const chars = [];
        try {
            if (c.groupId && Array.isArray(c.groups)) {
                const g = c.groups.find(x => x.id === c.groupId);
                (g?.members || []).forEach(av => {
                    const ch = c.characters?.find(x => x.avatar === av);
                    if (ch?.name) chars.push(ch.name);
                });
            } else if (c.characterId !== undefined && c.characters?.[c.characterId]?.name) {
                chars.push(c.characters[c.characterId].name);
            }
        } catch (e) { /* ignore */ }
        if (!chars.length && char) chars.push(char);
        return { user, char, chars };
    }

    function stripTags(text) {
        return String(text ?? '')
            .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .trim();
    }

    // --- Диагностика и лог генерации ---
    const diagLog = [];
    let sceneDrawing = false;
    let sceneDrawingStartedAt = 0;

    function logDiag(step, detail = '') {
        const ts = new Date().toTimeString().slice(0, 8);
        const entry = `[${ts}] ${step}${detail ? ': ' + String(detail).slice(0, 600) : ''}`;
        diagLog.push(entry);
        if (diagLog.length > 60) diagLog.shift();
        console.log('[nai_scene_illustrator]', entry);
    }

    async function openPopup(el, wide = false) {
        const c = ctx();
        if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
            return await c.callGenericPopup(el, c.POPUP_TYPE.TEXT, '', { wide, large: wide, okButton: 'Закрыть' });
        }
    }

    function closePopupOf(el) {
        el.closest('.popup, dialog').find('.popup-button-ok, .popup-button-close').first().trigger('click');
    }

    async function askText(title, initial = '') {
        const c = ctx();
        if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
            const r = await c.callGenericPopup(title, c.POPUP_TYPE.INPUT, initial, { rows: 4 });
            return typeof r === 'string' ? r : null;
        }
        return window.prompt(title, initial);
    }

    function showDiagPopup() {
        const el = $('<div class="nsi-pop"><h3>📋 Диагностика и лог генерации NovelAI</h3></div>');
        el.append('<div class="nsi-pop-sub">Пошаговый журнал последней генерации: какой промпт вернула текстовая модель, как отделился негатив и какой запрос ушёл в NovelAI.</div>');
        const area = $('<textarea class="text_pole" rows="14" readonly style="width:100%; font-family:monospace; font-size:0.82em; white-space:pre-wrap;"></textarea>')
            .val(diagLog.length ? diagLog.join('\n\n') : 'Записей пока нет. Нажми 🎬 на любом сообщении чата.');
        el.append(area);
        const row = $('<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;"></div>');
        row.append($('<div class="menu_button"><i class="fa-solid fa-rotate-left"></i> Сбросить зависшую генерацию</div>').on('click', () => {
            sceneDrawing = false;
            sceneDrawingStartedAt = 0;
            logDiag('Ручной сброс флага генерации');
            toastr.success('Флаг генерации сброшен!', '🎨 NovelAI');
            area.val(diagLog.join('\n\n'));
        }));
        row.append($('<div class="menu_button"><i class="fa-solid fa-trash"></i> Очистить лог</div>').on('click', () => {
            diagLog.length = 0;
            area.val('Лог очищен.');
        }));
        el.append(row);
        openPopup(el, true);
    }

    // --- Запрос к текстовой модели для составления промпта сцены ---
    function extractTextFromApiResult(raw) {
        if (!raw) return '';
        if (typeof raw === 'string') return raw;
        if (typeof raw?.content === 'string') return raw.content;
        if (Array.isArray(raw?.content)) {
            return raw.content.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('');
        }
        if (typeof raw?.text === 'string') return raw.text;
        if (typeof raw?.response === 'string') return raw.response;
        if (typeof raw?.result === 'string') return raw.result;
        if (typeof raw?.message?.content === 'string') return raw.message.content;
        if (Array.isArray(raw?.choices) && raw.choices[0]) {
            const msg = raw.choices[0].message || raw.choices[0].delta || raw.choices[0];
            if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content;
            if (Array.isArray(msg?.content)) return msg.content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
            if (typeof raw.choices[0]?.text === 'string' && raw.choices[0].text.trim()) return raw.choices[0].text;
            if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content;
        }
        if (Array.isArray(raw?.results) && raw.results[0]) {
            if (typeof raw.results[0]?.text === 'string') return raw.results[0].text;
            if (typeof raw.results[0]?.content === 'string') return raw.results[0].content;
        }
        if (Array.isArray(raw?.candidates) && raw.candidates[0]?.content?.parts) {
            return raw.candidates[0].content.parts.map(p => p?.text || '').join('');
        }
        if (raw?.data && typeof raw.data === 'object') {
            const inner = extractTextFromApiResult(raw.data);
            if (inner) return inner;
        }
        return '';
    }

    async function imagesFetch(url, init) {
        try {
            return await fetch(url, init);
        } catch (e) {
            const viaProxy = '/proxy/' + url;
            const res = await fetch(viaProxy, init).catch(() => null);
            if (!res || res.status === 404) {
                throw new Error('Браузер не пустил запрос (CORS). В config.yaml Таверны включи enableCorsProxy: true и перезапусти Таверну.');
            }
            return res;
        }
    }

    function buildStandaloneContextPrompt(taskPrompt) {
        const c = ctx();
        const s = settings();
        const names = storyNames();
        const parts = [];

        const ch = (c.characterId !== undefined && c.characters?.[c.characterId]) ? c.characters[c.characterId] : null;
        if (ch) {
            const desc = [ch.description, ch.personality, ch.scenario].filter(Boolean).join('\n').slice(0, 2400);
            if (desc) parts.push(`[Описание персонажа ${names.char}:\n${c.substituteParams(desc)}]`);
        }
        const personaDesc = c.powerUserSettings?.persona_description || c.extensionSettings?.persona?.description || '';
        if (personaDesc) {
            parts.push(`[Описание игрока ${names.user}:\n${c.substituteParams(String(personaDesc).slice(0, 1400))}]`);
        }

        const maxMsgs = Math.max(4, Math.min(40, Number(s.contextMsgs) || 15));
        const chat = Array.isArray(c.chat) ? c.chat : [];
        const recent = chat.filter(m => m && !m.is_system && m.mes).slice(-maxMsgs);
        if (recent.length) {
            const lines = recent.map(m => {
                const speaker = m.is_user ? names.user : (m.name || names.char);
                const clean = stripTags(String(m.mes || '')).replace(/<[^>]+>/g, '').slice(0, 1200);
                return `${speaker}: ${clean}`;
            });
            parts.push(`[Последние сообщения ролевой (контекст чата):\n${lines.join('\n\n')}]`);
        }

        parts.push(c.substituteParams(String(taskPrompt || '')));
        return parts.join('\n\n');
    }

    async function sendViaTavernProfile(profileId, fullPrompt, maxTokens = 2048, label = 'профиль Таверны', systemNote = '') {
        const svc = ctx().ConnectionManagerRequestService;
        if (!svc?.sendRequest) {
            throw new Error('В этой версии Таверны нет менеджера профилей подключения');
        }
        const prof = connectionProfiles().find(p => p.id === profileId || p.name === profileId);
        const pid = prof ? prof.id : profileId;
        const isTc = prof?.mode === 'tc';
        const chatMsgs = [];
        if (systemNote && String(systemNote).trim()) {
            chatMsgs.push({ role: 'system', content: String(systemNote).trim() });
        }
        chatMsgs.push({ role: 'user', content: fullPrompt });
        const singleUserMsgs = [{ role: 'user', content: fullPrompt }];

        const attempts = isTc
            ? [
                () => svc.sendRequest(pid, fullPrompt, maxTokens, { stream: false, extractData: true, includePreset: true }),
                () => svc.sendRequest(pid, fullPrompt, maxTokens, { stream: false, extractData: true, includePreset: false }),
                () => svc.sendRequest(pid, fullPrompt, maxTokens),
                () => svc.sendRequest(pid, singleUserMsgs, maxTokens, { stream: false, extractData: true, includePreset: true }),
            ]
            : [
                () => svc.sendRequest(pid, chatMsgs, maxTokens, { stream: false, extractData: true, includePreset: true }),
                () => svc.sendRequest(pid, singleUserMsgs, maxTokens, { stream: false, extractData: true, includePreset: true }),
                () => svc.sendRequest(pid, singleUserMsgs, maxTokens, { stream: false, extractData: true, includePreset: false }),
                () => svc.sendRequest(pid, singleUserMsgs, maxTokens, { stream: false, extractData: false, includePreset: true }),
                () => svc.sendRequest(pid, singleUserMsgs, maxTokens),
                () => svc.sendRequest(pid, fullPrompt, maxTokens, { stream: false, extractData: true, includePreset: true }),
                () => svc.sendRequest(pid, fullPrompt, maxTokens),
            ];

        let lastErr = null;
        for (const runAttempt of attempts) {
            try {
                const raw = await withTimeout(runAttempt(), 75000, label);
                const txt = extractTextFromApiResult(raw);
                if (txt && String(txt).trim()) return String(txt).trim();
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr || new Error(`Профиль «${prof?.name || pid}» вернул пустой ответ`);
    }

    async function generateScenePromptText(taskPrompt) {
        const s = settings();
        const src = String(s.imgPromptSource || '').trim();
        const writerNote = String(s.imgPromptWriterNote || '').trim();

        if (src) {
            try {
                const writerBlock = writerNote ? `[Авторская инструкция составителю промптов картинок:\n${writerNote}]\n\n` : '';
                const fullPrompt = writerBlock + buildStandaloneContextPrompt(taskPrompt);

                if (src === 'custom-api') {
                    let base = String(s.imgPromptApiBase || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/+$/, '');
                    const key = String(s.imgPromptApiKey || '').trim();
                    const model = String(s.imgPromptApiModel || 'glm-4-plus').trim();
                    if (!base || !key || !model) {
                        throw new Error('Заполни адрес API, ключ и название модели для промптов картинок');
                    }
                    if (base.includes('generativelanguage.googleapis.com') && !base.includes('/openai')) {
                        base = 'https://generativelanguage.googleapis.com/v1beta/openai';
                    }
                    const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
                    const messages = [];
                    if (writerNote) messages.push({ role: 'system', content: writerNote });
                    messages.push({ role: 'user', content: fullPrompt });
                    const res = await withTimeout(imagesFetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${key}`,
                        },
                        body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.6 }),
                    }), 75000, `модель промптов (${model})`);
                    const text = await res.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch (e) {}
                    if (!res.ok) {
                        throw new Error(`API промптов (${res.status}): ${String(json?.error?.message || text).slice(0, 200)}`);
                    }
                    return stripTags(extractTextFromApiResult(json) || text);
                }

                const profText = await sendViaTavernProfile(src, fullPrompt, 2048, 'профиль модели промптов картинок', writerNote);
                if (profText) return stripTags(profText);
            } catch (err) {
                console.warn('[nai_scene_illustrator] standalone prompt model failed, falling back to main chat:', err);
                toastr.warning(`Отдельная модель промптов не ответила (${escapeHtml(err?.message || err)}) — использую основную модель чата.`, '🎨 Промпт сцены', { escapeHtml: false, timeOut: 6000 });
            }
        }

        const fn = ctx().generateQuietPrompt;
        const res = fn.length === 0 ? await fn({ quietPrompt: taskPrompt }) : await fn(taskPrompt, false, false);
        return stripTags(res);
    }

    // --- Обработка референсов и ZIP-ответов NovelAI ---
    async function storeImage(url) {
        if (!url.startsWith('data:')) return url;
        try {
            const [, format, data] = url.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i) || [];
            if (!data) return url;
            const res = await fetch('/api/images/upload', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({ image: data, format: format.replace('jpeg', 'jpg'), ch_name: 'Сцена', filename: `nai_scene_${Date.now()}` }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            return json.path || url;
        } catch (e) {
            return url;
        }
    }

    async function fileToDataUrl(file) {
        if (!file) return '';
        if (file.startsWith('data:')) return file;
        try {
            const res = await fetch(file.startsWith('/') || file.startsWith('http') ? file : '/' + file.split('/').map(encodeURIComponent).join('/'));
            if (!res.ok) return '';
            const blob = await res.blob();
            if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) return '';
            return await new Promise(r => {
                const fr = new FileReader();
                fr.onload = () => r(String(fr.result || ''));
                fr.onerror = () => r('');
                fr.readAsDataURL(blob);
            });
        } catch (e) {
            return '';
        }
    }

    function characterAvatars() {
        const c = ctx();
        let list = [];
        try {
            if (c.groupId && Array.isArray(c.groups)) {
                const g = c.groups.find(x => x.id === c.groupId);
                list = (g?.members || []).map(av => c.characters.find(ch => ch.avatar === av)).filter(Boolean);
            } else if (c.characterId !== undefined && c.characters?.[c.characterId]) {
                list = [c.characters[c.characterId]];
            }
        } catch (e) { list = []; }
        return list.filter(ch => ch.avatar && ch.avatar !== 'none').map(ch => ({ name: ch.name, file: `characters/${ch.avatar}` }));
    }

    async function personaAvatarDataUrl() {
        try {
            const chat = ctx().chat || [];
            let file = '';
            for (let i = chat.length - 1; i >= 0 && !file; i--) {
                if (chat[i]?.is_user && chat[i].force_avatar) file = chat[i].force_avatar;
            }
            if (!file) {
                const id = $('#user_avatar_block .avatar-container.selected').attr('data-avatar-id') || $('#user_avatar_block .selected').attr('imgfile');
                if (id) file = `User Avatars/${id}`;
            }
            if (!file) return '';
            return await fileToDataUrl(file);
        } catch (e) {
            return '';
        }
    }

    async function formatRefForNovelAiDirector(dataUrl) {
        if (!dataUrl || typeof Image !== 'function') return '';
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                try {
                    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
                    let W = 1024, H = 1536;
                    if (w / h > 1.2) { W = 1536; H = 1024; }
                    else if (w / h > 0.85) { W = 1472; H = 1472; }
                    const cv = document.createElement('canvas');
                    cv.width = W;
                    cv.height = H;
                    const g = cv.getContext('2d');
                    g.fillStyle = '#000000';
                    g.fillRect(0, 0, W, H);
                    const scale = Math.min(W / w, H / h);
                    const dw = Math.round(w * scale), dh = Math.round(h * scale);
                    const dx = Math.floor((W - dw) / 2), dy = Math.floor((H - dh) / 2);
                    g.drawImage(img, dx, dy, dw, dh);
                    const out = cv.toDataURL('image/png');
                    const m = out.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
                    resolve(m ? m[1] : '');
                } catch (e) {
                    const m = String(dataUrl).match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
                    resolve(m ? m[1] : '');
                }
            };
            img.onerror = () => {
                const m = String(dataUrl).match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
                resolve(m ? m[1] : '');
            };
            img.src = dataUrl;
        });
    }

    async function extractFirstFileFromZip(u8) {
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        if (view.getUint32(0, true) !== 0x04034b50) return null;
        const method = view.getUint16(8, true);
        const nameLen = view.getUint16(26, true);
        const extraLen = view.getUint16(28, true);
        const dataStart = 30 + nameLen + extraLen;
        let compSize = view.getUint32(18, true);
        if (compSize === 0 || compSize > u8.byteLength - dataStart) {
            for (let i = u8.byteLength - 22; i >= 0; i--) {
                if (view.getUint32(i, true) === 0x06054b50) {
                    const cdOffset = view.getUint32(i + 16, true);
                    if (cdOffset + 24 <= u8.byteLength && view.getUint32(cdOffset, true) === 0x02014b50) {
                        compSize = view.getUint32(cdOffset + 20, true);
                    }
                    break;
                }
            }
        }
        const compData = compSize > 0 ? u8.subarray(dataStart, dataStart + compSize) : u8.subarray(dataStart);
        if (method === 0) return compData;
        if (method === 8 && typeof DecompressionStream === 'function') {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compData);
            writer.close();
            const buf = await new Response(ds.readable).arrayBuffer();
            return new Uint8Array(buf);
        }
        return null;
    }

    function uint8ToBase64(u8) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < u8.length; i += chunk) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
        }
        return btoa(bin);
    }

    async function parseNovelAiResponse(res) {
        if (!res.ok) {
            const errTxt = await res.text().catch(() => '');
            let msg = errTxt;
            try { msg = JSON.parse(errTxt)?.message || JSON.parse(errTxt)?.error || errTxt; } catch (e) {}
            throw new Error(`NovelAI (${res.status}): ${String(msg).slice(0, 240)}`);
        }
        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        if (ctype.includes('application/json') || ctype.includes('text/plain')) {
            const txt = (await res.text()).trim();
            if (txt.startsWith('data:image')) return txt;
            if (txt.startsWith('/') || txt.startsWith('http')) return txt;
            try {
                const j = JSON.parse(txt);
                const d = j.data || j.image || j.url || j.output;
                if (typeof d === 'string') {
                    return d.startsWith('data:') || d.startsWith('/') || d.startsWith('http') ? d : `data:image/png;base64,${d}`;
                }
            } catch (e) {}
        }
        const buf = await res.arrayBuffer();
        const u8 = new Uint8Array(buf);
        if (!u8.length) throw new Error('NovelAI вернул пустой ответ');
        if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
            return `data:image/png;base64,${uint8ToBase64(u8)}`;
        }
        if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) {
            return `data:image/webp;base64,${uint8ToBase64(u8)}`;
        }
        if (u8[0] === 0x50 && u8[1] === 0x4B) {
            const imgBytes = await extractFirstFileFromZip(u8);
            if (imgBytes && imgBytes.length) {
                const mime = (imgBytes[0] === 0x52 && imgBytes[1] === 0x49) ? 'image/webp' : 'image/png';
                return `data:${mime};base64,${uint8ToBase64(imgBytes)}`;
            }
        }
        throw new Error('Не удалось распаковать картинку из ответа NovelAI');
    }

    // --- Отделение "| NEGATIVE: ..." и защита тегов одежды для NovelAI ---
    function splitPositiveAndNegativePrompt(rawText) {
        let text = String(rawText || '').trim();
        const extraNegParts = [];
        const negRegex = /(?:\s*\|\s*|\s+—\s+|\n+\s*|\[\s*)(?:NEGATIVE(?:\s+PROMPT)?|UNDESIRED(?:\s+CONTENT)?|UC)\s*[:：—–-]\s*([\s\S]+)$/i;
        const m = text.match(negRegex);
        if (m) {
            const negTail = m[1].replace(/\]\s*$/, '').trim();
            if (negTail) extraNegParts.push(negTail);
            text = text.slice(0, m.index).trim();
        }
        text = text.replace(/\s*\|+\s*$/g, '').trim();
        return { positive: text, negative: extraNegParts.join(', ') };
    }

    function sanitizeNovelAiPositiveAndNegative(posPrompt, negPrompt) {
        let pos = String(posPrompt || '').trim();
        let neg = String(negPrompt || '').trim();

        const split = splitPositiveAndNegativePrompt(pos);
        pos = split.positive;
        if (split.negative) {
            neg = [neg, split.negative].filter(Boolean).join(', ');
        }

        const isExplicitlyShirtless = /\b(shirtless|bare chest|bare torso|topless|naked torso|unbuttoned|open shirt|open cardigan showing chest)\b/i.test(pos);
        const hasUpperClothes = /\b(cardigan|sweater|jacket|coat|hoodie|shirt|t-shirt|turtleneck|vest|blazer|suit|uniform)\b/i.test(pos);

        if (!isExplicitlyShirtless && hasUpperClothes) {
            pos = pos.replace(/\bflat\s+male\s+chest\b/gi, 'masculine upper body');
            pos = pos.replace(/\bmale\s+chest\b/gi, 'masculine torso');
            if (/\bcardigan\b/i.test(pos) && !/\b(shirt|t-shirt|tee|turtleneck|sweater|blouse|top|under\s+cardigan)\b/i.test(pos)) {
                pos = pos.replace(/\b([a-z]+\s+cardigan|cardigan)\b/i, '$1 over plain shirt, closed front');
            }
        }

        if (/\bno\s+(?:breasts|female\s+chest|chest)\b/i.test(pos)) {
            pos = pos.replace(/,?\s*\bno\s+(?:breasts|female\s+chest|chest)\b/gi, '');
            if (!/\bbreasts\b/i.test(neg)) {
                neg = `breasts, female chest, ${neg}`;
            }
        }

        const userStyle = String(settings().naiPrefix || '').trim();
        if (userStyle) {
            pos = pos.replace(/\b(?:anime\s+style|semi-realistic\s+anime|masterpiece|best\s+quality|very\s+aesthetic|amazing\s+quality|highres)\b\s*,?\s*/gi, '');
        }

        pos = pos.replace(/,\s*,+/g, ', ').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
        return { pos, neg };
    }

    async function drawViaNovelAi(prompt, orient = 'portrait', refs = null) {
        const s = settings();
        const model = String(s.naiModel || 'nai-diffusion-5-full-medium').trim();
        const isV5Medium = /nai-diffusion-5-full-medium/i.test(model);
        const isV5 = /nai-diffusion-5/i.test(model);
        const isV4Plus = /nai-diffusion-[45]/i.test(model);

        const sampler = isV5Medium ? 'k_euler_ancestral' : String(s.naiSampler || 'k_euler_ancestral').trim();
        const scheduler = String(s.naiScheduler || 'karras').trim();
        const steps = isV5Medium ? 14 : Math.max(1, Math.min(50, Number(s.naiSteps) || 28));
        const scale = Math.max(1, Math.min(20, Number(s.naiScale) || 5.0));
        const cfgRescale = isV5Medium ? 0 : Math.max(0, Math.min(1, Number(s.naiRescale ?? 0)));

        const prefix = String(s.naiPrefix ?? '').trim();
        let baseNeg = String(s.naiNegative ?? defaults.naiNegative).trim();
        if (refs?.extraNeg) {
            baseNeg = [baseNeg, refs.extraNeg].filter(Boolean).join(', ');
        }
        const sanitized = sanitizeNovelAiPositiveAndNegative(prompt, baseNeg);
        let negPrompt = sanitized.neg;
        const cleanPrompt = sanitized.pos.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (/NOT looking at viewer/i.test(cleanPrompt) && !/looking at viewer/i.test(negPrompt)) {
            negPrompt = `looking at viewer, looking at camera, eye contact with viewer, ${negPrompt}`;
        }

        let width = 832, height = 1216;
        if (orient === 'landscape') { width = 1216; height = 832; }
        else if (orient === 'square') { width = 1024; height = 1024; }

        const fullPrompt = [prefix, cleanPrompt].filter(Boolean).join(', ');
        logDiag(`Запуск NovelAI (${model}, steps=${steps}, scale=${scale}, rescale=${cfgRescale}, ${width}x${height})`, `ПОЗИТИВ: ${fullPrompt}\nНЕГАТИВ: ${negPrompt}`);
        const seed = Math.floor(Math.random() * 4294967295);
        const token = String(s.naiApiKey || '').trim();

        if (token) {
            const params = {
                params_version: isV5 ? 4 : 3,
                width,
                height,
                scale,
                sampler,
                steps,
                seed,
                n_samples: 1,
                ucPreset: isV5Medium ? 2 : 0,
                qualityToggle: !prefix,
                sm: false,
                sm_dyn: false,
                dynamic_thresholding: false,
                controlnet_strength: 1,
                legacy: false,
                add_original_image: true,
                cfg_rescale: cfgRescale,
                noise_schedule: scheduler,
                legacy_v3_extend: false,
                uncond_scale: 1,
                negative_prompt: negPrompt,
                prompt: fullPrompt,
                reference_image_multiple: [],
                reference_information_extracted_multiple: [],
                reference_strength_multiple: [],
                extra_noise_seed: seed,
            };
            if (isV4Plus) {
                params.v4_prompt = {
                    use_coords: false,
                    use_order: true,
                    caption: { base_caption: fullPrompt, char_captions: [] },
                };
                params.v4_negative_prompt = {
                    use_coords: false,
                    use_order: false,
                    caption: { base_caption: negPrompt, char_captions: [] },
                };
            }

            const refMode = String(s.naiCharRefMode || 'char_no_style');
            const hasRefs = Array.isArray(refs?.images) && refs.images.length > 0;
            let attachedRef = false;
            if (hasRefs && refMode !== 'off') {
                const b64 = await formatRefForNovelAiDirector(refs.images[0]);
                if (b64) {
                    if (/nai-diffusion-4-5/i.test(model)) {
                        const isCharAndStyle = refMode === 'char_and_style';
                        const isStyleOnly = refMode === 'style_only';
                        const baseCap = isStyleOnly ? 'style' : (isCharAndStyle ? 'character&style' : 'character');
                        const secStrength = (isCharAndStyle || isStyleOnly) ? 0.2 : 0.55;
                        params.director_reference_images = [b64];
                        params.director_reference_descriptions = [
                            { caption: { base_caption: baseCap, char_captions: [] }, legacy_uc: false },
                        ];
                        params.director_reference_information_extracted = [1];
                        params.director_reference_strength_values = [0.85];
                        params.director_reference_secondary_strength_values = [secStrength];
                        attachedRef = true;
                        logDiag('NovelAI V4.5 Character Reference прикреплён', `режим=${baseCap}`);
                    } else if (!isV4Plus) {
                        params.reference_image_multiple = [b64];
                        params.reference_information_extracted_multiple = [1];
                        params.reference_strength_multiple = [0.6];
                        attachedRef = true;
                    }
                }
            }

            const sendNaiDirect = async pObj => {
                const res = await withTimeout(
                    imagesFetch('https://image.novelai.net/ai/generate-image', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            Accept: '*/*',
                        },
                        body: JSON.stringify({ input: fullPrompt, model, action: 'generate', parameters: pObj }),
                    }),
                    90000,
                    'NovelAI рисунок'
                );
                return await parseNovelAiResponse(res);
            };

            try {
                const dataUrl = await sendNaiDirect(params);
                return await storeImage(dataUrl);
            } catch (err) {
                if (isV5Medium && params.negative_prompt) {
                    logDiag('Повтор V5 Medium со стандартным пресетом негатива (14 шагов)');
                    params.negative_prompt = '';
                    if (params.v4_negative_prompt?.caption) params.v4_negative_prompt.caption.base_caption = '';
                    const dataUrl = await sendNaiDirect(params);
                    return await storeImage(dataUrl);
                }
                if (attachedRef) {
                    delete params.director_reference_images;
                    delete params.director_reference_descriptions;
                    delete params.director_reference_information_extracted;
                    delete params.director_reference_strength_values;
                    delete params.director_reference_secondary_strength_values;
                    params.reference_image_multiple = [];
                    params.reference_information_extracted_multiple = [];
                    params.reference_strength_multiple = [];
                    const dataUrl = await sendNaiDirect(params);
                    return await storeImage(dataUrl);
                }
                throw err;
            }
        }

        const stRes = await withTimeout(
            fetch('/api/novelai/generate-image', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({
                    prompt: fullPrompt,
                    model,
                    sampler,
                    scheduler,
                    steps,
                    scale,
                    width,
                    height,
                    negative_prompt: negPrompt,
                    seed,
                    n_samples: 1,
                }),
            }),
            90000,
            'NovelAI через Таверну'
        );
        const dataUrl = await parseNovelAiResponse(stRes);
        return await storeImage(dataUrl);
    }

    // --- Построение запроса на описание сцены ---
    function buildScenePromptRequest(mesId, camMode = 'third', forcedCast = null) {
        const isPov = camMode === 'pov' || camMode === 'pov_hands' || camMode === 'pov_clean';
        const isPovHands = camMode === 'pov' || camMode === 'pov_hands';
        const names = storyNames();
        const c = ctx();
        const chat = c.chat || [];
        let targetIdx = Number.isInteger(mesId) ? mesId : (chat.length - 1);
        while (targetIdx >= 0 && (!chat[targetIdx] || chat[targetIdx].is_system)) targetIdx--;
        const msg = targetIdx >= 0 ? chat[targetIdx] : null;
        const prevMsg = targetIdx > 0 ? chat.slice(Math.max(0, targetIdx - 2), targetIdx).filter(m => m && !m.is_system && m.mes) : [];

        const prevContext = prevMsg.length
            ? `Контекст прямо перед этим моментом (чтобы не потерять присутствующих в сцене персонажей и NPC):\n` +
              prevMsg.map(m => `${m.is_user ? names.user : (m.name || names.char)}: «${stripTags(String(m.mes || '')).replace(/<[^>]+>/g, '').slice(0, 500)}»`).join('\n')
            : '';
        const moment = msg?.mes
            ? `Главный момент, который нужно нарисовать (${msg.is_user ? names.user : (msg.name || names.char)}): «${stripTags(String(msg.mes || '')).replace(/<[^>]+>/g, '').slice(0, 1500)}»`
            : '';

        const rawPersonaDesc = c.powerUserSettings?.persona_description || c.extensionSettings?.persona?.description || '';
        const cleanPersonaAppearance = rawPersonaDesc ? c.substituteParams(String(rawPersonaDesc)).replace(/\s+/g, ' ').trim().slice(0, 700) : '';
        const userAppearanceLine = (!isPov && cleanPersonaAppearance)
            ? `Внешность героини игрока ${names.user} из анкеты Персоны (обязательно подробно опиши её внешность по-английски в SCENE, если она в кадре!): ${cleanPersonaAppearance}.`
            : '';

        const rawMainCh = (c.characterId !== undefined && c.characters?.[c.characterId]) ? c.characters[c.characterId] : null;
        const rawMainChDesc = rawMainCh?.description ? c.substituteParams(String(rawMainCh.description)).replace(/\s+/g, ' ').trim().slice(0, 900) : '';
        const charAppearanceLine = rawMainChDesc
            ? `Внешность персонажа ${names.char} из его карточки (обязательно подробно опиши его внешность по-английски в SCENE, если он в кадре!): ${rawMainChDesc}.`
            : '';

        const forcedCastLine = Array.isArray(forcedCast) && forcedCast.length
            ? `ВАЖНО — ИГРОК ЯВНО УКАЗАЛ, КТО ДОЛЖЕН БЫТЬ В КАДРЕ: ${forcedCast.join(', ')}. Обязательно включи ВСЕХ перечисленных (${forcedCast.length} чел.) в строку CAST и подробно опиши внешность, одежду и позу КАЖДОГО из них в строке SCENE!`
            : '';

        let cameraInstruction = '';
        if (isPovHands) {
            cameraInstruction = `ВАЖНО — ВИД ОТ ПЕРВОГО ЛИЦА С ЭФФЕКТОМ ПРИСУТСТВИЯ (POV HANDS): картинка строго глазами ${names.user} (first-person POV). Строго ЗАПРЕЩЕНО рисовать голову, лицо, волосы, плечи или спину ${names.user}! На переднем плане с края кадра МОЖЕТ быть видна рука или ладонь ${names.user} (pov hands reaching out, holding an object, or touching the character), а перед ней на уровне глаз — все собеседники в сцене. В CAST саму ${names.user} НЕ пиши.`;
        } else if (isPov) {
            cameraInstruction = `ВАЖНО — ЧИСТЫЙ ВЗГЛЯД НАПРОТИВ (ГЛАЗАМИ ГЕРОИНИ): покажи то, что видит перед собой ${names.user} на уровне глаз (eye-level medium shot facing the viewer). Саму ${names.user} в кадре НЕ описывай и в CAST не включай.`;
        } else {
            cameraInstruction = `ВАЖНО — КИНОКАДР СО СТОРОНЫ (ВСЕ УЧАСТНИКИ СЦЕНЫ, НЕ ТЕРЯЙ NPC!):
1) Проверь по тексту сообщения и контексту, КТО ИМЕННО находится в этой сцене прямо сейчас.
2) СТРОГО ЗАПРЕЩЕНО по шаблону оставлять только ${names.user} и ${names.char}, если в сцене также присутствуют другие персонажи или NPC!
3) Если в сцене 3 или более человек — обязательно перечисли их ВСЕХ в CAST, а описание SCENE начни с точного числа людей в кадре (например: "Group of 3 people in the scene..."), чтобы генератор нарисовал каждого!
4) Персонажи смотрят ДРУГ НА ДРУГА или на своё занятие в сцене, а НЕ в камеру / НЕ на зрителя!`;
        }

        return [
            '[OOC: Пауза в ролевой игре. Сейчас ты НЕ пишешь ответ персонажа. Ты — помощник художника: опиши картинку того, что происходит в сцене прямо сейчас.',
            prevContext,
            moment,
            userAppearanceLine,
            charAppearanceLine,
            forcedCastLine,
            cameraInstruction,
            settings().imgPromptWriterNote?.trim()
                ? `ВАЖНАЯ ИНСТРУКЦИЯ ОТ АВТОРА ДЛЯ СОСТАВЛЕНИЯ ПРОМПТА КАРТИНКИ (СОБЛЮДАЙ СТРОГО, ОСОБЕННО ПО АНАТОМИИ И ПОЗАМ):\n${settings().imgPromptWriterNote.trim()}`
                : '',
            'Формат для NovelAI: пиши строку SCENE на английском языке, сочетая чёткие теги (например: 1girl, 1boy, mature adult, natural body proportions, anatomically correct hands) и наглядное описание внешности, одежды, естественных поз и освещения. ВАЖНЫЕ ПРАВИЛА ДЛЯ NOVELAI: 1) НЕ пиши в начале SCENE общие слова стиля (вроде anime style, semi-realistic, masterpiece, best quality, artstyle) — авторский стиль рисовки подставляется отдельно 1-в-1! 2) НИКОГДА не пиши "| NEGATIVE:" внутри строки SCENE (если нужны негативные теги — вынеси их на отдельную третью строку NEGATIVE: ...). 3) Если персонаж одет (например, в кардиган, свитер, куртку или рубашку), НИКОГДА не пиши в позитивном промпте теги "flat male chest", "male chest" или "no breasts" (в словаре NovelAI тег "male chest" означает голую открытую грудь нараспашку!). Если на персонаже кардиган/куртка не на голое тело — явно указывай футболку или рубашку под ним (например: wearing plain shirt under baggy cardigan, closed cardigan, fully clothed).',
            'Ответь ровно двумя строками, без пояснений:',
            `CAST: кто именно виден в кадре через запятую (${isPov ? names.chars.join(', ') : [names.user, ...names.chars].join(', ')}; плюс имена любых присутствующих NPC; или none, если в кадре никого нет)`,
            'SCENE: один подробный абзац по-английски для генератора картинок NovelAI: точное количество людей в кадре, подробная внешность (пол, волосы, глаза, черты, одежда) и естественная анатомически правильная поза КАЖДОГО присутствующего персонажа, их взаимодействие, куда направлен взгляд, место, свет и настроение.]',
        ].filter(Boolean).join('\n');
    }

    function findSavedSceneMeta(mesId) {
        const c = ctx();
        if (Number.isInteger(mesId) && c.chat?.[mesId]?.extra?.nsiScene?.prompt) {
            return c.chat[mesId].extra.nsiScene;
        }
        if (Number.isInteger(mesId) && c.chat?.[mesId]?.extra?.nnbScene?.prompt) {
            return c.chat[mesId].extra.nnbScene;
        }
        return null;
    }

    async function askSceneCameraMode(existingMeta = null) {
        const mode = settings().sceneCameraMode || 'ask';
        if (mode !== 'ask' && !existingMeta?.prompt) return { mode };
        return new Promise(resolve => {
            const el = $('<div class="nsi-pop"><h3>🎬 Как нарисовать эту сцену в NovelAI?</h3></div>');
            let settled = false;
            const finish = val => {
                if (settled) return;
                settled = true;
                closePopupOf(el);
                resolve(val);
            };

            if (existingMeta?.prompt) {
                const reuseBox = $('<div class="nsi-note" style="border-color:var(--SmartThemeQuoteColor, #8b78c4);"></div>');
                reuseBox.append('<div style="font-weight:700; margin-bottom:4px;">🔄 Уже есть готовый промпт для этой сцены</div>');
                reuseBox.append($('<div style="font-size:0.82em; opacity:0.85; margin-bottom:8px; max-height:70px; overflow-y:auto;"></div>').text(existingMeta.desc || existingMeta.prompt));
                const reuseBtns = $('<div style="display:flex; gap:8px; flex-wrap:wrap;"></div>');
                reuseBtns.append($('<div class="menu_button nsi-btn-primary" style="margin:0;"><i class="fa-solid fa-rotate"></i> Перерисовать по тому же промпту</div>').on('click', () => {
                    finish({ mode: existingMeta.camMode || 'third', reuseMeta: existingMeta });
                }));
                reuseBtns.append($('<div class="menu_button" style="margin:0;"><i class="fa-solid fa-pen"></i> Подправить промпт и перерисовать</div>').on('click', async () => {
                    const edited = await askText('Промпт сцены на английском для NovelAI:', existingMeta.desc || existingMeta.prompt);
                    if (edited && edited.trim()) {
                        finish({
                            mode: existingMeta.camMode || 'third',
                            reuseMeta: { ...existingMeta, desc: edited.trim(), prompt: '' },
                        });
                    }
                }));
                reuseBox.append(reuseBtns);
                el.append(reuseBox);
            }

            const names = storyNames();
            const castCandidates = [...new Set([names.user, ...names.chars].filter(Boolean))];
            const selectedCast = new Set();
            const castBox = $('<div class="nsi-note"></div>');
            castBox.append('<div style="font-weight:600; font-size:0.86em; margin-bottom:4px;">👥 Кто сейчас в кадре? (по желанию — отметь или допиши NPC через запятую):</div>');
            const chipsRow = $('<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px;"></div>');
            castCandidates.forEach(cName => {
                const chip = $('<div class="nsi-cast-chip" tabindex="0"></div>').text(cName);
                chip.on('click', () => {
                    if (selectedCast.has(cName)) {
                        selectedCast.delete(cName);
                        chip.removeClass('active');
                    } else {
                        selectedCast.add(cName);
                        chip.addClass('active');
                    }
                });
                chipsRow.append(chip);
            });
            const extraNpcInput = $('<input type="text" class="text_pole" placeholder="Дополнительные персонажи/NPC в сцене через запятую (если есть)…" style="width:100%; font-size:0.84em;">');
            castBox.append(chipsRow, extraNpcInput);
            el.append(castBox);

            const getForcedCast = () => {
                const list = [...selectedCast];
                const extra = String(extraNpcInput.val() || '').split(',').map(x => x.trim()).filter(Boolean);
                return [...new Set([...list, ...extra])];
            };

            const btnCol = $('<div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;"></div>');
            btnCol.append($('<div class="menu_button nsi-btn-primary" style="padding:10px 12px; text-align:left;"><i class="fa-solid fa-users"></i> <b>🎬 Взгляд со стороны (все, кто в сцене)</b><br><small style="opacity:0.85;">Кинокадр со всеми участниками сцены (персонажи смотрят друг на друга, а не в камеру)</small></div>').on('click', () => {
                const fc = getForcedCast();
                finish({ mode: 'third', forcedCast: fc.length ? fc : null });
            }));
            btnCol.append($('<div class="menu_button" style="padding:10px 12px; text-align:left;"><i class="fa-solid fa-hand"></i> <b>🤚 От первого лица с эффектом присутствия (POV Hands)</b><br><small style="opacity:0.85;">Взгляд глазами героини (в кадре может быть видна её рука или жест)</small></div>').on('click', () => {
                const fc = getForcedCast();
                finish({ mode: 'pov_hands', forcedCast: fc.length ? fc : null });
            }));
            btnCol.append($('<div class="menu_button" style="padding:10px 12px; text-align:left;"><i class="fa-solid fa-eye"></i> <b>👀 Чистый взгляд напротив (глазами героини)</b><br><small style="opacity:0.85;">Портрет собеседника прямо перед тобой на уровне глаз</small></div>').on('click', () => {
                const fc = getForcedCast();
                finish({ mode: 'pov_clean', forcedCast: fc.length ? fc : null });
            }));
            btnCol.append($('<div class="menu_button" style="padding:6px 12px; text-align:center;"><i class="fa-solid fa-xmark"></i> Отмена</div>').on('click', () => finish(null)));
            el.append(btnCol);

            openPopup(el, false).then(() => finish(null));
        });
    }

    async function drawScene(mesId, camMode = 'third', reuseMeta = null, forcedCast = null) {
        if (sceneDrawing) {
            const elapsed = sceneDrawingStartedAt ? Math.round((Date.now() - sceneDrawingStartedAt) / 1000) : 0;
            if (elapsed > 95) {
                sceneDrawing = false;
            } else {
                toastr.info(`Сцена уже рисуется (${elapsed} сек.). Если зависло — нажми «⏹ Сбросить» в настройках расширения.`, '🎨 NovelAI');
                return null;
            }
        }
        const c = ctx();
        if (!c.chat?.length) {
            toastr.warning('Сначала открой чат', '🎨 NovelAI');
            return null;
        }
        sceneDrawing = true;
        sceneDrawingStartedAt = Date.now();
        try {
            if (reuseMeta?.camMode) camMode = reuseMeta.camMode;
            const isPov = camMode === 'pov' || camMode === 'pov_hands' || camMode === 'pov_clean';
            const isPovHands = camMode === 'pov' || camMode === 'pov_hands';
            let desc = '';
            let extraNeg = reuseMeta?.extraNeg || '';
            let cast = [];

            if (reuseMeta && (reuseMeta.desc || reuseMeta.prompt)) {
                const splitReuse = splitPositiveAndNegativePrompt(reuseMeta.desc || reuseMeta.prompt);
                desc = splitReuse.positive;
                if (splitReuse.negative) extraNeg = [extraNeg, splitReuse.negative].filter(Boolean).join(', ');
                cast = Array.isArray(reuseMeta.cast) ? reuseMeta.cast : [];
                logDiag('Перерисовка по готовому промпту', desc);
            } else {
                logDiag(`Шаг 1/2: запрос промпта сцены (ракурс: ${camMode})`);
                const raw = await generateScenePromptText(buildScenePromptRequest(mesId, camMode, forcedCast));
                logDiag('Ответ модели промптов получен', raw ? String(raw).slice(0, 500) : '(пусто)');
                const lines = String(raw || '').replace(/\*\*/g, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    let m = line.match(/^CAST\s*[:：—–-]\s*(.+)$/i);
                    if (m) {
                        const rawCast = m[1].trim();
                        if (/^(none|никого|нет|пусто|-)$/i.test(rawCast)) cast = ['__none__'];
                        else cast = rawCast.split(/[,;]/).map(x => x.trim().toLowerCase().replace(/ё/g, 'е')).filter(Boolean);
                        continue;
                    }
                    m = line.match(/^(?:NEGATIVE(?:\s+PROMPT)?|UNDESIRED(?:\s+CONTENT)?|UC)\s*[:：—–-]\s*(.+)$/i);
                    if (m) {
                        extraNeg = [extraNeg, m[1].trim().replace(/\]$/, '')].filter(Boolean).join(', ');
                        continue;
                    }
                    m = line.match(/^SCENE\s*[:：—–-]\s*(.+)$/i);
                    if (m) desc = m[1].trim().replace(/\]$/, '');
                }
                if (!desc && lines.length) {
                    const fallback = lines.filter(l => !/^(CAST|NEGATIVE|UC)\s*[:：—–-]/i.test(l));
                    if (fallback.length) desc = fallback.join(' ').trim();
                }
                const splitDesc = splitPositiveAndNegativePrompt(desc);
                desc = splitDesc.positive;
                if (splitDesc.negative) {
                    extraNeg = [extraNeg, splitDesc.negative].filter(Boolean).join(', ');
                    logDiag('Блок | NEGATIVE автоматически отделён в негативный промпт', splitDesc.negative);
                }
                if (Array.isArray(forcedCast) && forcedCast.length) {
                    forcedCast.forEach(fc => {
                        const nFc = fc.trim().toLowerCase().replace(/ё/g, 'е');
                        if (nFc && (!isPov || nFc !== storyNames().user.toLowerCase().replace(/ё/g, 'е')) && !cast.some(c2 => c2.includes(nFc) || nFc.includes(c2))) {
                            cast.push(nFc);
                        }
                    });
                }
                if (!desc) throw new Error('Модель не вернула описание сцены (SCENE)');
            }

            const names = storyNames();
            const norm = x => String(x || '').toLowerCase().replace(/ё/g, 'е');
            const noOneInFrame = cast.length === 1 && cast[0] === '__none__';
            const inFrame = n => !noOneInFrame && (!cast.length || cast.some(c2 => c2.includes(norm(n)) || norm(n).includes(c2)));
            const images = [];
            const who = [];

            if (settings().naiCharRefMode !== 'off' && !noOneInFrame) {
                for (const ch of characterAvatars()) {
                    if (!inFrame(ch.name)) continue;
                    const img = await fileToDataUrl(ch.file);
                    if (img) { images.push(img); who.push(ch.name); break; }
                }
                if (!images.length && !isPov && inFrame(names.user)) {
                    const me = await personaAvatarDataUrl();
                    if (me) { images.push(me); who.push(names.user); }
                }
            }

            const totalPeopleCount = noOneInFrame ? 0 : Math.max(cast.length, who.length);
            const countPrefix = (!isPov && totalPeopleCount >= 3 && !/\b(three|four|five|3|4|5)\s+(people|characters|figures)\b/i.test(desc))
                ? `Scene with ${totalPeopleCount} people visible in frame (${cast.join(', ')}): `
                : '';
            const cameraSuffix = isPovHands
                ? `first-person POV, pov hands in foreground, viewer head and torso out of frame, eye-level perspective, single illustration, no text, no captions.`
                : isPov
                    ? `eye-level medium shot from viewer's perspective, single illustration, no text, no captions.`
                    : (totalPeopleCount >= 3
                        ? `candid cinematic group scene with all ${totalPeopleCount} characters clearly visible in frame, characters looking at each other and interacting naturally, NOT looking at viewer, NOT looking at camera, single illustration, no text, no captions.`
                        : totalPeopleCount === 2
                            ? `candid cinematic scene, characters looking at each other, interacting naturally, NOT looking at viewer, NOT looking at camera, single illustration, no text, no captions.`
                            : `candid cinematic scene, natural gaze, NOT looking at camera, single illustration, no text, no captions.`);

            const rawCombined = (reuseMeta?.prompt && reuseMeta.desc === desc)
                ? splitPositiveAndNegativePrompt(reuseMeta.prompt).positive
                : `${countPrefix}${desc}. ${cameraSuffix}`.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            const prompt = splitPositiveAndNegativePrompt(rawCombined).positive;
            const orient = settings().imgOrientation || 'portrait';

            logDiag(`Шаг 2/2: отправка промпта в NovelAI (${settings().naiModel})`);
            const url = await withTimeout(drawViaNovelAi(prompt, orient, { images, extraNeg }), 120000, 'NovelAI рисунок сцены');
            logDiag('Картинка успешно получена!', url);
            return { url, sceneMeta: { desc, extraNeg, cast, camMode, prompt, pov: isPov } };
        } catch (err) {
            console.warn('[nai_scene_illustrator] error:', err);
            logDiag('ОШИБКА генерации сцены', err?.message || String(err));
            toastr.warning(`Сцену нарисовать не вышло: ${escapeHtml(err?.message || err)}`, '🎨 NovelAI', { escapeHtml: false, timeOut: 9000 });
            return null;
        } finally {
            sceneDrawing = false;
            sceneDrawingStartedAt = 0;
        }
    }

    async function attachToMessage(url, mesId, sceneMeta = null, silentToast = false) {
        const c = ctx();
        for (let i = Number.isInteger(mesId) ? mesId : c.chat.length - 1; i >= 0; i--) {
            const m = c.chat[i];
            if (!m || m.is_system) continue;
            m.extra = m.extra || {};
            const prevHistory = Array.isArray(m.extra.nsiScene?.history)
                ? [...m.extra.nsiScene.history]
                : (m.extra.nsiScene?.url ? [m.extra.nsiScene.url] : []);
            if (url && !prevHistory.includes(url)) prevHistory.push(url);
            if (sceneMeta) {
                m.extra.nsiScene = { ...sceneMeta, url, history: prevHistory, mesId: i };
            } else if (m.extra.nsiScene) {
                m.extra.nsiScene.url = url;
                m.extra.nsiScene.history = prevHistory;
            }
            const imgDesc = Object.getOwnPropertyDescriptor(m.extra, 'image');
            const newApi = Array.isArray(m.extra.media) || (imgDesc && typeof imgDesc.get === 'function') || typeof c.appendMediaToMessage === 'function';
            if (newApi) {
                if (!Array.isArray(m.extra.media)) m.extra.media = [];
                if (!m.extra.media_display) m.extra.media_display = 'gallery';
                const existingIdx = m.extra.media.findIndex(x => x.url === url);
                if (existingIdx >= 0) {
                    m.extra.media_index = existingIdx;
                } else {
                    const countGen = m.extra.media.filter(x => x.source === 'generated' || String(x.title || '').startsWith('Сцена')).length;
                    m.extra.media.push({ url, type: 'image', title: countGen ? `Сцена #${countGen + 1}` : 'Сцена', source: 'generated' });
                    m.extra.media_index = m.extra.media.length - 1;
                }
            } else {
                m.extra.image = url;
                m.extra.title = 'Сцена';
            }
            m.extra.inline_image = true;
            try { if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(i, m); } catch (e) {}
            await c.saveChat();
            placeButtonsSoon();
            if (!silentToast) {
                toastr.success(
                    prevHistory.length > 1
                        ? `Новая картинка добавлена под пост (вариантов: ${prevHistory.length} — листай ◀ ▶ или жми ▶ для новой генерации по тому же промпту)!`
                        : 'Картинка сцены добавлена под пост! Жми стрелку вправо ▶ под картинкой, чтобы сгенерировать ещё вариант по тому же промпту.',
                    '🎨 NovelAI',
                    { timeOut: 5500 }
                );
            }
            return;
        }
    }

    async function redrawBySamePrompt(mesId, customMeta = null) {
        if (!Number.isInteger(mesId)) mesId = undefined;
        if (sceneDrawing) return toastr.info('Сцена уже рисуется — картинка появится под постом сама', '🎨 NovelAI');
        const meta = customMeta || findSavedSceneMeta(mesId);
        if (!meta || (!meta.prompt && !meta.desc)) {
            return triggerScenePopup(mesId);
        }
        const note = toastr.info('Рисую ещё один вариант по тому же промпту (без запроса к текстовой модели)…', '🔄 Ещё вариант сцены', { timeOut: 60000, extendedTimeOut: 15000, tapToDismiss: true });
        try {
            const res = await drawScene(mesId, meta.camMode || 'third', meta);
            if (res?.url) {
                await attachToMessage(res.url, mesId, res.sceneMeta);
            }
        } finally {
            try { toastr.clear(note); } catch (e) {}
        }
    }

    async function triggerScenePopup(mesId) {
        if (!Number.isInteger(mesId)) mesId = undefined;
        if (sceneDrawing) return toastr.info('Сцена уже рисуется — картинка появится под постом сама', '🎨 NovelAI');
        const existingMeta = findSavedSceneMeta(mesId);
        const choice = await askSceneCameraMode(existingMeta);
        if (!choice) return;
        const camMode = choice.mode || 'third';
        const reuseMeta = choice.reuseMeta || null;
        const forcedCast = choice.forcedCast || null;
        const note = toastr.info('Рисую сцену через NovelAI… Нажми на уведомление, чтобы скрыть.', '🎨 NovelAI', { timeOut: 60000, extendedTimeOut: 15000, tapToDismiss: true });
        try {
            const res = await drawScene(mesId, camMode, reuseMeta, forcedCast);
            if (res?.url) {
                await attachToMessage(res.url, mesId, res.sceneMeta);
            }
        } finally {
            try { toastr.clear(note); } catch (e) {}
        }
    }

    function placeButtons() {
        const on = !!settings().enabled;
        const c = ctx();
        const mes = $('#chat .mes');
        if (!on) {
            $('.nsi-mes-btn, .nsi-inline-scene-bar').remove();
            return;
        }
        mes.each(function () {
            const mesEl = $(this);
            const box = mesEl.find('.mes_buttons').first();
            if (!box.length) return;
            const mId = Number(mesEl.attr('mesid'));
            const sceneMeta = Number.isInteger(mId) ? (c.chat?.[mId]?.extra?.nsiScene || c.chat?.[mId]?.extra?.nnbScene) : null;
            const hasSavedPrompt = !!(sceneMeta?.prompt || sceneMeta?.desc);

            // Если в Таверне уже активен полный «Блокнот рассказчика», не дублируем иконку на сообщении
            if (!box.find('.nnb-mes-scene').length) {
                if (!box.find('.nsi-mes-scene').length) {
                    box.prepend('<div class="mes_button nsi-mes-btn nsi-mes-scene fa-solid fa-image interactable" title="Нарисовать эту сцену через NovelAI" tabindex="0"></div>');
                }
                if (hasSavedPrompt && !box.find('.nsi-mes-scene-redraw').length) {
                    box.find('.nsi-mes-scene').after('<div class="mes_button nsi-mes-btn nsi-mes-scene-redraw fa-solid fa-rotate interactable" title="Перерисовать сцену по тому же промпту" tabindex="0"></div>');
                } else if (!hasSavedPrompt) {
                    box.find('.nsi-mes-scene-redraw').remove();
                }
            }

            // Переставляем блок картинки строго ПОД текст поста (.mes_text), чтобы ничего не перекрывало текст
            const mesText = mesEl.find('.mes_text').first();
            const mediaWrapper = mesEl.find('.mes_media_wrapper').first();
            const imgCont = mesEl.find('.mes_img_container').first();
            if (mediaWrapper.length && mesText.length && mediaWrapper.index() < mesText.index()) {
                mesText.after(mediaWrapper);
            } else if (imgCont.length && mesText.length && imgCont.parent().is(mesEl.find('.mes_block')) && imgCont.index() < mesText.index()) {
                mesText.after(imgCont);
            }

            if (mesEl.find('.nnb-inline-scene-bar').length) return;
            mesEl.find('.nsi-inline-scene-bar').remove();

            if (imgCont.length && sceneMeta && (sceneMeta.prompt || sceneMeta.desc)) {
                const hist = Array.isArray(sceneMeta.history) && sceneMeta.history.length ? sceneMeta.history : (sceneMeta.url ? [sceneMeta.url] : []);
                let cIdx = hist.indexOf(sceneMeta.url);
                if (cIdx < 0) cIdx = hist.length - 1;
                const curUrl = hist[cIdx] || sceneMeta.url || '';
                if (curUrl) {
                    const imgEl = imgCont.find('img.mes_img').first();
                    if (imgEl.length && imgEl.attr('src') !== curUrl) {
                        imgEl.attr('src', curUrl);
                    }
                }
                const isLastSlide = cIdx >= hist.length - 1;

                const bar = $('<div class="nsi-inline-scene-bar"></div>');
                const navRow = $('<div class="nsi-inline-scene-nav"></div>');
                const prevBtn = $(`<div class="menu_button" style="padding:4px 12px; font-size:0.84em; margin:0; ${cIdx <= 0 ? 'opacity:0.35; pointer-events:none;' : ''}" title="Предыдущий вариант (◀)"><i class="fa-solid fa-chevron-left"></i></div>`).on('click', async e => {
                    e.stopPropagation();
                    if (cIdx <= 0) return;
                    const prevUrl = hist[cIdx - 1];
                    sceneMeta.url = prevUrl;
                    await attachToMessage(prevUrl, mId, sceneMeta, true);
                });
                const promptToggleBtn = $(`<div class="menu_button" style="padding:4px 10px; font-size:0.82em; margin:0;" title="Показать/подправить промпт этой сцены"><i class="fa-solid fa-pen-to-square"></i> Вариант ${cIdx + 1} / ${hist.length}</div>`);
                const nextBtn = $(`<div class="menu_button ${isLastSlide ? 'nsi-btn-primary' : ''}" style="padding:4px 12px; font-size:0.84em; margin:0;" title="${isLastSlide ? 'Сгенерировать ещё одну картинку по тому же промпту (▶)' : 'Следующий вариант (▶)'}"><span>${isLastSlide ? '+ Ещё ' : ''}</span><i class="fa-solid fa-chevron-right"></i></div>`).on('click', async function (e) {
                    e.stopPropagation();
                    if (!isLastSlide) {
                        const nextUrl = hist[cIdx + 1];
                        sceneMeta.url = nextUrl;
                        await attachToMessage(nextUrl, mId, sceneMeta, true);
                    } else {
                        const btn = $(this);
                        btn.css({ opacity: 0.6, pointerEvents: 'none' }).html('<i class="fa-solid fa-spinner fa-spin"></i> Рисую…');
                        await redrawBySamePrompt(mId, sceneMeta);
                    }
                });
                navRow.append(prevBtn, promptToggleBtn, nextBtn);
                bar.append(navRow);

                const promptBox = $('<div style="display:none; width:100%; margin-top:6px;"></div>');
                const promptArea = $('<textarea class="text_pole" rows="3" style="width:100%; font-size:0.82em;" placeholder="Промпт этой сцены (можно подправить вручную и нажать ▶)"></textarea>').val(sceneMeta.desc || sceneMeta.prompt || '');
                promptArea.on('click', e => e.stopPropagation());
                promptArea.on('input change', function () {
                    const val = String($(this).val() || '').trim();
                    if (val) {
                        sceneMeta.desc = val;
                        sceneMeta.prompt = '';
                    }
                });
                promptBox.append(promptArea);
                bar.append(promptBox);

                promptToggleBtn.on('click', e => {
                    e.stopPropagation();
                    promptBox.slideToggle(150);
                });

                imgCont.after(bar);
            }
        });
    }

    let btnTimer = null;
    function placeButtonsSoon() {
        clearTimeout(btnTimer);
        btnTimer = setTimeout(placeButtons, 150);
    }

    const PANEL_HTML = `
<div class="nai-scene-illustrator-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🎨 Иллюстратор сцен NovelAI</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content nsi-scope" id="nsi_panel">
      <label class="checkbox_label"><input type="checkbox" id="nsi_enabled"> Включено (кнопка 🖼 на сообщениях чата)</label>

      <details class="nsi-set" open>
        <summary>🎨 Настройки генератора NovelAI (V5 Medium / V5 Full / V4.5)</summary>
        <input type="password" class="text_pole" id="nsi_nai_key" placeholder="Ключ NovelAI (pst-…) — или пусто, если ключ уже в Таверне" autocomplete="off" style="margin-top:6px;">
        <select class="text_pole" id="nsi_nai_model" title="Модель NovelAI" style="margin-top:6px;">
          <option value="nai-diffusion-5-full-medium">NovelAI V5 Medium (14 шагов — рекомендуется)</option>
          <option value="nai-diffusion-5-full">NovelAI V5 Full (High — 28 шагов)</option>
          <option value="nai-diffusion-5-curated">NovelAI V5 Curated</option>
          <option value="nai-diffusion-4-5-full">NovelAI V4.5 Full (с картинкой-референсом)</option>
          <option value="nai-diffusion-4-5-curated">NovelAI V4.5 Curated</option>
          <option value="nai-diffusion-4-full">NovelAI V4 Full</option>
          <option value="nai-diffusion-3">NovelAI Anime V3</option>
        </select>

        <div style="font-size:0.84em; font-weight:600; margin-top:8px;">✨ Мой стиль для NovelAI (вставляется 1-в-1 в начало промпта в обход модели!):</div>
        <small style="display:block; opacity:0.8; margin-bottom:4px;">Вставь сюда свои теги стиля и художников со всеми скобками <code>{...}</code>, <code>[...]</code> и весами <code>1.2::...::</code> — текстовая модель их не тронет:</small>
        <textarea class="text_pole" id="nsi_nai_prefix" rows="3" placeholder="Вставь сюда свой собранный стиль для NovelAI…"></textarea>

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
          <div style="flex:1; min-width:120px;">
            <label style="font-size:0.78em; opacity:0.85;">Guidance (Scale, ~5.0):</label>
            <input type="number" step="0.5" min="1" max="20" class="text_pole" id="nsi_nai_scale" style="margin-top:2px;">
          </div>
          <div style="flex:1; min-width:120px;">
            <label style="font-size:0.78em; opacity:0.85;">Rescale (для V5 High / V4.5):</label>
            <input type="number" step="0.05" min="0" max="1" class="text_pole" id="nsi_nai_rescale" style="margin-top:2px;">
          </div>
        </div>

        <select class="text_pole" id="nsi_img_orient" title="Формат иллюстраций" style="margin-top:6px;">
          <option value="portrait">Вертикальные картинки (832×1216)</option>
          <option value="landscape">Горизонтальные картинки (1216×832)</option>
          <option value="square">Квадратные картинки (1024×1024)</option>
        </select>

        <select class="text_pole" id="nsi_scene_cam" title="Ракурс для картинок сцен" style="margin-top:6px;">
          <option value="ask">Ракурс сцен (🎬): спрашивать при нажатии</option>
          <option value="third">Ракурс сцен (🎬): взгляд со стороны (все, кто в сцене)</option>
          <option value="pov_hands">Ракурс сцен (🎬): POV с эффектом присутствия (рука в кадре)</option>
          <option value="pov_clean">Ракурс сцен (🎬): чистый взгляд из глаз (без рук)</option>
        </select>

        <div style="font-size:0.82em; opacity:0.85; margin-top:6px;">🖼 Что брать с аватарки-референса (для V4.5 Character Reference):</div>
        <select class="text_pole" id="nsi_nai_char_ref" style="margin-top:2px;">
          <option value="char_no_style">Только внешность персонажа — БЕЗ стиля аватарки (рекомендуется)</option>
          <option value="char_and_style">Внешность персонажа + стиль рисовки с аватарки</option>
          <option value="style_only">Только стиль рисовки с аватарки (внешность по тексту)</option>
          <option value="off">Выкл: рисовать только по текстовому описанию и тегам (без аватарки)</option>
        </select>

        <div style="font-size:0.82em; opacity:0.85; margin-top:6px;">🚫 Базовый негативный промпт (Undesired Content):</div>
        <textarea class="text_pole" id="nsi_nai_neg" rows="2" placeholder="Негативный промпт (uc)" style="margin-top:2px;"></textarea>
      </details>

      <details class="nsi-set" open>
        <summary>🧠 Какая модель пишет промпты для картинок (например, GLM)</summary>
        <small style="display:block; opacity:0.8; margin:4px 0;">Позволяет генерировать промпты для NovelAI отдельной быстрой моделью (не той, на которой идёт ролевая):</small>
        <select class="text_pole" id="nsi_img_prompt_src"></select>
        <div id="nsi_img_prompt_api" style="display:none; margin-top:6px;">
          <input type="password" class="text_pole" id="nsi_img_prompt_key" placeholder="Ключ API (от GLM / Zhipu, OpenRouter или прокси)" autocomplete="off">
          <input type="text" class="text_pole" id="nsi_img_prompt_model" placeholder="Модель (например: glm-4-plus или glm-4-flash)" style="margin-top:4px;">
          <input type="text" class="text_pole" id="nsi_img_prompt_base" placeholder="https://open.bigmodel.cn/api/paas/v4 (или адрес прокси)" style="margin-top:4px;">
        </div>
        <div style="font-size:0.84em; font-weight:600; margin-top:8px;">✍️ Промпт писателя картинок (инструкция по анатомии и позам):</div>
        <textarea class="text_pole" id="nsi_img_writer_note" rows="4" placeholder="Правила описания поз, анатомии и рук (без тегов стиля)…" style="margin-top:4px;"></textarea>
        <div class="menu_button" id="nsi_fill_writer_tpl" style="margin-top:4px; padding:4px 10px; font-size:0.82em;"><i class="fa-solid fa-wand-magic-sparkles"></i> Вставить шаблон с защитой анатомии</div>
      </details>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
        <div class="menu_button" id="nsi_diag_btn" style="padding:5px 10px; font-size:0.82em;"><i class="fa-solid fa-bug"></i> 📋 Диагностика и лог картинок</div>
        <div class="menu_button" id="nsi_reset_btn" style="padding:5px 10px; font-size:0.82em;"><i class="fa-solid fa-rotate-left"></i> ⏹ Сбросить зависшую генерацию</div>
      </div>
    </div>
  </div>
</div>`;

    function fillPromptSources() {
        const sel = $('#nsi_img_prompt_src');
        if (!sel.length) return;
        const cur = settings().imgPromptSource || '';
        sel.empty().append($('<option value=""></option>').text('Основная модель чата (текущее подключение Таверны)'));
        for (const p of connectionProfiles()) {
            sel.append($('<option></option>').val(p.id).text(`Профиль Таверны: ${p.name}`));
        }
        sel.append($('<option value="custom-api"></option>').text('Свой API по ключу (например, GLM / OpenRouter / Gemini Flash)'));
        if (cur && cur !== 'custom-api' && !connectionProfiles().some(p => p.id === cur)) {
            sel.append($('<option></option>').val(cur).text('(профиль удалён)'));
        }
        sel.val(cur);
        $('#nsi_img_prompt_api').toggle(cur === 'custom-api');
    }

    jQuery(async () => {
        if ($('#nsi_panel').length) return;
        $('#extensions_settings2').append(PANEL_HTML);

        const s = settings();
        $('#nsi_enabled').prop('checked', !!s.enabled).on('change', function () {
            s.enabled = $(this).prop('checked');
            saveSettings();
            placeButtons();
        });
        $('#nsi_nai_key').val(s.naiApiKey || '').on('input change', function () {
            s.naiApiKey = String($(this).val() || '');
            saveSettings();
        });
        $('#nsi_nai_model').val(s.naiModel || 'nai-diffusion-5-full-medium').on('change', function () {
            s.naiModel = String($(this).val() || 'nai-diffusion-5-full-medium');
            saveSettings();
        });
        $('#nsi_nai_prefix').val(s.naiPrefix ?? '').on('input change', function () {
            s.naiPrefix = String($(this).val() ?? '');
            saveSettings();
        });
        $('#nsi_nai_scale').val(s.naiScale ?? 5.0).on('input change', function () {
            const v = Number($(this).val());
            if (!Number.isNaN(v) && v >= 1 && v <= 20) {
                s.naiScale = v;
                saveSettings();
            }
        });
        $('#nsi_nai_rescale').val(s.naiRescale ?? 0).on('input change', function () {
            const v = Number($(this).val());
            if (!Number.isNaN(v) && v >= 0 && v <= 1) {
                s.naiRescale = v;
                saveSettings();
            }
        });
        $('#nsi_img_orient').val(s.imgOrientation || 'portrait').on('change', function () {
            s.imgOrientation = String($(this).val() || 'portrait');
            saveSettings();
        });
        $('#nsi_scene_cam').val(s.sceneCameraMode || 'ask').on('change', function () {
            s.sceneCameraMode = String($(this).val() || 'ask');
            saveSettings();
        });
        $('#nsi_nai_char_ref').val(s.naiCharRefMode || 'char_no_style').on('change', function () {
            s.naiCharRefMode = String($(this).val() || 'char_no_style');
            saveSettings();
        });
        $('#nsi_nai_neg').val(s.naiNegative ?? defaults.naiNegative).on('input change', function () {
            s.naiNegative = String($(this).val() ?? '');
            saveSettings();
        });

        fillPromptSources();
        $('.nai-scene-illustrator-settings .inline-drawer-toggle').on('click', fillPromptSources);
        $('#nsi_img_prompt_src').on('change', function () {
            s.imgPromptSource = String($(this).val() || '');
            saveSettings();
            fillPromptSources();
        });
        $('#nsi_img_prompt_key').val(s.imgPromptApiKey || '').on('input change', function () {
            s.imgPromptApiKey = String($(this).val() || '');
            saveSettings();
        });
        $('#nsi_img_prompt_model').val(s.imgPromptApiModel || 'glm-4-plus').on('input change', function () {
            s.imgPromptApiModel = String($(this).val() || '');
            saveSettings();
        });
        $('#nsi_img_prompt_base').val(s.imgPromptApiBase || 'https://open.bigmodel.cn/api/paas/v4').on('input change', function () {
            s.imgPromptApiBase = String($(this).val() || '');
            saveSettings();
        });
        $('#nsi_img_writer_note').val(s.imgPromptWriterNote ?? DEFAULT_NAI_WRITER_PROMPT).on('input change', function () {
            s.imgPromptWriterNote = String($(this).val() ?? '');
            saveSettings();
        });
        $('#nsi_fill_writer_tpl').on('click', function () {
            s.imgPromptWriterNote = DEFAULT_NAI_WRITER_PROMPT;
            $('#nsi_img_writer_note').val(DEFAULT_NAI_WRITER_PROMPT);
            saveSettings();
            toastr.success('Шаблон промпта писателя с защитой анатомии подставлен!', '✍️ Промпт писателя');
        });
        $('#nsi_diag_btn').on('click', showDiagPopup);
        $('#nsi_reset_btn').on('click', () => {
            sceneDrawing = false;
            sceneDrawingStartedAt = 0;
            logDiag('Ручной сброс зависшей генерации');
            toastr.success('Зависшая генерация сброшена!', '🎨 NovelAI');
        });

        $(document).on('click', '.nsi-mes-scene', function (e) {
            e.stopPropagation();
            const id = Number($(this).closest('.mes').attr('mesid'));
            triggerScenePopup(Number.isInteger(id) ? id : undefined);
        });
        $(document).on('click', '.nsi-mes-scene-redraw', function (e) {
            e.stopPropagation();
            const id = Number($(this).closest('.mes').attr('mesid'));
            redrawBySamePrompt(Number.isInteger(id) ? id : undefined);
        });

        const menu = $('#extensionsMenu');
        if (menu.length && !$('#nsi_menu_scene').length) {
            const item = $('<div id="nsi_menu_scene" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="fa-solid fa-image extensionsMenuExtensionButton"></div><span>Нарисовать сцену (NovelAI)</span></div>');
            item.on('click', () => triggerScenePopup());
            menu.append(item);
        }

        const c = ctx();
        const ev = c.event_types || {};
        for (const k of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED']) {
            if (ev[k]) c.eventSource.on(ev[k], placeButtonsSoon);
        }
        try {
            const chatEl = document.getElementById('chat');
            if (chatEl) new MutationObserver(placeButtonsSoon).observe(chatEl, { childList: true });
        } catch (e) {}

        placeButtons();
    });
})();
