import { ctx, log, warn } from './env.js';
import { sanitizeGenParams } from './config.js';

const REQUEST_TIMEOUT_MS = 600000;

export function normalizeBaseUrl(raw) {
    const base = String(raw || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    const url = base.replace(/\/chat\/completions$/i, '');
    if (/\/(v\d+|beta)$/i.test(url)) return url;
    return url + '/v1';
}

function friendlyError(err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('ECONNRESET') || msg.includes('socket hang up')) {
        return 'Kết nối API bị ngắt, vui lòng kiểm tra mạng hoặc cấu hình API';
    }
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('Timeout')) {
        return 'Yêu cầu API quá thời gian, vui lòng thử lại sau';
    }
    return msg || 'Lỗi không xác định';
}

function buildGenerationPayload({ apiCfg, genParams, messages }) {
    const payload = {
        messages,
        model: apiCfg.model,
        chat_completion_source: 'openai',
        reverse_proxy: normalizeBaseUrl(apiCfg.url),
        proxy_password: apiCfg.key || '',
        stream: apiCfg.stream !== false,
    };
    // Chỉ gửi các tham số mà người chơi bật rõ ràng và đã qua làm sạch tính hợp lệ; phần còn lại không đưa vào payload yêu cầu,
    // do upstream sử dụng giá trị mặc định (Ngăn chặn các giá trị không hợp lệ như top_k=0 đến tay nhà cung cấp)
    const gen = sanitizeGenParams(genParams);
    for (const key of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'max_tokens']) {
        if (gen[key] !== undefined) payload[key] = gen[key];
    }
    if (gen.reasoning_effort) {
        payload.reasoning_effort = gen.reasoning_effort;
    }
    return payload;
}

/**
 * Dịch vụ yêu cầu chính thức của Tavern (ChatCompletionService của ST 1.16 custom-request.js):
 * Dùng chung một endpoint backend, cùng một quy ước lắp ráp payload, cùng một bộ phân tích SSE
 * (EventSourceStream + getStreamingReply) với quá trình tạo trò chuyện bình thường, yêu cầu gửi ra có hình thức giống hệt với tạo văn bản bình thường của Tavern.
 */
async function callViaTavernService({ apiCfg, genParams, messages, signal }) {
    const c = ctx();
    const service = c?.ChatCompletionService;
    if (!service || typeof service.processRequest !== 'function') {
        return null;
    }
    const payload = service.createRequestData
        ? service.createRequestData(buildGenerationPayload({ apiCfg, genParams, messages }))
        : buildGenerationPayload({ apiCfg, genParams, messages });

    const result = await service.processRequest(payload, {}, true, signal);

    if (payload.stream) {
        if (typeof result !== 'function') {
            throw new Error('Định dạng phản hồi luồng bất thường');
        }
        let text = '';
        let chunkCount = 0;
        let lastChunkDump = '';
        for await (const chunk of result()) {
            chunkCount++;
            text = chunk.text || text;
            lastChunkDump = JSON.stringify(chunk)?.slice(0, 300) || String(chunk);
        }
        if (!text.trim()) {
            // Chẩn đoán: Chạy hết luồng nhưng văn bản tích lũy trống - in ra số lượng chunk và hình dạng gốc của chunk cuối cùng,
            // phân biệt ba trường hợp: endpoint thực sự không trả ra văn bản (chặn an toàn/luồng giả mạo),
            // chỉ trả ra reasoning_content (mô hình tư duy không xuất nội dung chính), hình thái trường chunk không khớp
            warn(`streaming finished with empty text: ${chunkCount} chunk(s) received, last chunk = ${lastChunkDump || '(no chunks)'}`);
            throw new Error('Nội dung API trả về trống');
        }
        return text;
    }

    const content = result?.content;
    if (!content || String(content).trim().length < 1) {
        warn(`non-stream response empty: ${JSON.stringify(result)?.slice(0, 300)}`);
        throw new Error('Nội dung API trả về trống');
    }
    return String(content);
}

function extractContentFromResponse(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    if (choice?.message?.content !== undefined) return String(choice.message.content);
    if (choice?.text !== undefined) return String(choice.text);
    if (typeof data?.content === 'string') return data.content;
    if (typeof data?.text === 'string') return data.text;
    return '';
}

/**
 * Tương thích dự phòng (fallback): Trực tiếp yêu cầu endpoint backend của Tavern (Môi trường không có ChatCompletionService).
 * Vẫn do máy chủ Tavern chuyển tiếp ra ngoài, không tạo ra kết nối trực tiếp từ trình duyệt.
 * forceNonStream: Bắt buộc không dùng luồng (non-stream). Lỗi upstream của yêu cầu không luồng sẽ được trả về nguyên bản dưới dạng JSON {error:{message}}
 * (thay vì truyền qua mã trạng thái của luồng), có thể lấy được văn bản báo lỗi thực sự của nhà cung cấp.
 */
async function callViaBackendEndpoint({ apiCfg, genParams, messages, forceNonStream = false }) {
    const c = ctx();
    if (!c || typeof c.getRequestHeaders !== 'function') throw new Error('SillyTavern context unavailable');
    const payload = buildGenerationPayload({ apiCfg, genParams, messages });
    if (forceNonStream) payload.stream = false;
    if (!payload.reverse_proxy) throw new Error('Chưa cấu hình địa chỉ API');
    if (!payload.model) throw new Error('Chưa cấu hình tên model');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...c.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        if (payload.stream && response.body) {
            return await readSseStream(response);
        }

        const data = await response.json();
        if (data?.error) throw new Error(String(data.message || data.error?.message || 'API returned error'));
        const text = extractContentFromResponse(data);
        if (!text) throw new Error('Nội dung API trả về trống');
        return text;
    } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || e) === 'timeout') {
            throw new Error('Yêu cầu API quá thời gian, vui lòng thử lại sau');
        }
        throw new Error(friendlyError(e));
    } finally {
        clearTimeout(timer);
    }
}

async function readSseStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const chunk = JSON.parse(payload);
                if (chunk.error) throw new Error(String(chunk.message || 'stream error'));
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') result += delta;
                const messageContent = chunk.choices?.[0]?.message?.content;
                if (!delta && typeof messageContent === 'string') result += messageContent;
            } catch (e) {
                if (e instanceof SyntaxError) continue;
                throw e;
            }
        }
    }
    if (!result.trim()) throw new Error('Nội dung API trả về trống');
    return result;
}

/**
 * Đường dẫn API chính: Đi qua gọi quiet của generateRaw nguyên bản của Tavern.
 * - Prompt bỏ qua tiêm preset: Gọi quiet không qua prepareOpenAIMessages (main prompt/jailbreak/thẻ nhân vật/lịch sử trò chuyện
 *   đều sẽ không được tiêm vào), thứ gửi đi chỉ là mảng tin nhắn do RUBY lắp ráp phá giới hạn, cùng cơ chế với prompt im lặng của bản thân Tavern;
 * - Tham số lấy mẫu (sampling): Gọi quiet mặc định kế thừa cài đặt lấy mẫu của preset hiện tại, ở đây thông qua hook sự kiện
 *   CHAT_COMPLETION_SETTINGS_READY chính thức ghi đè theo cấu hình RUBY (xác nhận so sánh tham chiếu chỉ có tác dụng với yêu cầu lần này, nhận được là tháo ra ngay).
 */
async function callMainApi({ genParams, messages }) {
    const c = ctx();
    if (!c || typeof c.generateRaw !== 'function') throw new Error('generateRaw unavailable');

    const options = { prompt: messages };
    const maxLength = Number(genParams.max_tokens);
    if (Number.isFinite(maxLength) && maxLength > 0) {
        options.responseLength = maxLength;
    }

    const sanitized = sanitizeGenParams(genParams);
    const patchable = {};
    for (const key of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty']) {
        if (sanitized[key] !== undefined) patchable[key] = sanitized[key];
    }
    if (sanitized.reasoning_effort) patchable.reasoning_effort = sanitized.reasoning_effort;

    let hook = null;
    const detach = () => {
        if (hook) {
            c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, hook);
            hook = null;
        }
    };

    const isChatCompletion = c.mainApi === 'openai';
    if (Object.keys(patchable).length > 0 && isChatCompletion && c.eventSource && c.eventTypes?.CHAT_COMPLETION_SETTINGS_READY) {
        const marker = messages[0];
        hook = (generateData) => {
            // So sánh tham chiếu: createRawPrompt/createGenerationParameters đều không thay thế đối tượng tin nhắn, tham chiếu không đổi
            if (!Array.isArray(generateData?.messages) || !generateData.messages.includes(marker)) return;
            Object.assign(generateData, patchable);
            detach();
        };
        c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, hook);
    } else if (Object.keys(patchable).length > 0 && !isChatCompletion) {
        warn('API chính hiện tại là kênh completion văn bản, tham số tạo RUBY không ghi đè (tiếp tục dùng cài đặt lấy mẫu của kết nối Tavern hiện tại)');
    }

    try {
        const text = await c.generateRaw(options);
        if (!text || String(text).trim().length < 1) throw new Error('Nội dung API trả về trống');
        return String(text);
    } finally {
        detach();
    }
}

let providerNonStreamOnly = false;

export async function callModel({ apiCfg, genParams, messages, taskLabel }) {
    const viaMain = apiCfg.provider !== 'custom';
    // Tóm tắt payload: Mỗi lần gọi đều in ra số lượng tin nhắn/chuỗi vai trò/tổng số ký tự - đối chiếu song song giữa nhiệm vụ và đạo diễn trên cùng kênh,
    // khi trả về rỗng thì trực tiếp so sánh sự khác biệt payload hai bên, không cần đoán nữa
    const payloadSummary = Array.isArray(messages)
        ? `${messages.length} tin nhắn [${messages.map((m) => m?.role || '?').join(',')}] ${messages.reduce((sum, m) => sum + String(m?.content ?? '').length, 0)} ký tự`
        : `Payload không phải mảng: ${typeof messages}`;
    log(`AI call: ${taskLabel || 'task'} | channel=${viaMain ? 'tavern generateRaw quiet (Kênh chính, bỏ qua tiêm preset)' : 'tavern ChatCompletionService (Endpoint tùy chỉnh)'} | url=${viaMain ? '-' : (apiCfg.url || 'Chưa cấu hình')} | model=${viaMain ? 'Kết nối Tavern hiện tại' : (apiCfg.model || 'Chưa thiết lập')} | stream=${viaMain ? '(Bản thân kênh chính)' : (apiCfg.stream !== false)} | payload=${payloadSummary}`);

    if (viaMain) {
        return callMainApi({ genParams, messages });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    try {
        const effectiveStream = !providerNonStreamOnly && apiCfg.stream !== false;
        try {
            const text = await callViaTavernService({ apiCfg: { ...apiCfg, stream: effectiveStream }, genParams, messages, signal: controller.signal });
            if (text !== null) return text;
            warn('ChatCompletionService unavailable, falling back to backend endpoint request');
            return await callViaBackendEndpoint({ apiCfg: { ...apiCfg, stream: effectiveStream }, genParams, messages });
        } catch (e) {
            const msg = String(e?.message || e || '');
            // Đường dẫn luồng của dịch vụ chính thức sẽ loại bỏ phần body lỗi upstream (throw của tryParseStreamingError bị
            // catch của chính nó nuốt mất, chỉ còn lại "Got response status NNN"). Lúc này dùng không luồng để thử lại một lần:
            // Lỗi upstream không luồng sẽ trả về nguyên bản bằng JSON, có thể lấy được báo lỗi thực sự của nhà cung cấp;
            // Nếu nhà cung cấp chỉ là không hỗ trợ luồng, thử lại sẽ thành công ngay.
            // Lưu ý: Thiết lập luồng thành công nhưng nội dung rỗng không nằm trong trường hợp này - phương thức truyền tải phải hoàn toàn đi theo cài đặt API cơ sở RUBY,
            // không thực hiện bất kỳ thiết kế hạ cấp/chuyển đổi độc lập nào.
            if (/^Got response status/.test(msg)) {
                warn(`upstream rejected the request (${msg}); retrying without stream to surface the provider error`);
                const text = await callViaBackendEndpoint({ apiCfg, genParams, messages, forceNonStream: true });
                if (apiCfg.stream !== false && !providerNonStreamOnly) {
                    providerNonStreamOnly = true;
                    warn('provider rejected streaming but succeeded without it; remaining calls in this session will skip streaming');
                }
                return text;
            }
            throw e instanceof Error ? e : new Error(msg);
        }
    } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || e) === 'timeout') {
            throw new Error('Yêu cầu API quá thời gian, vui lòng thử lại sau');
        }
        throw new Error(friendlyError(e));
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchModelList(baseUrl, apiKey) {
    const c = ctx();
    const cleanBase = String(baseUrl || '').trim()
        .replace(/\/+$/, '')
        .replace(/\/(?:v\d+|beta)\/chat\/completions$/i, '')
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/models$/i, '');

    if (!cleanBase) throw new Error('Vui lòng điền địa chỉ API');

    if (typeof c?.getRequestHeaders === 'function') {
        try {
            const res = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: 'openai',
                    reverse_proxy: cleanBase,
                    proxy_password: apiKey || '',
                }),
            });
            if (res.ok) {
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
                if (items.length > 0) return [...new Set(items)];
            }
        } catch { /* fall through to direct fetch */ }
    }

    const candidates = [...new Set([
        `${cleanBase}/models`,
        `${cleanBase}/v1/models`,
        /\/(v\d+|beta)$/i.test(cleanBase) ? `${cleanBase.replace(/\/(v\d+|beta)$/i, '')}/v1/models` : '',
    ].filter(Boolean))];

    let lastError = '';
    for (const url of candidates) {
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${apiKey || ''}`, 'Accept': 'application/json' },
            });
            if (res.ok) {
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
                if (items.length > 0) return [...new Set(items)];
            }
            lastError = `${res.status} ${res.statusText || ''}`.trim();
        } catch (e) {
            lastError = e?.message || '';
        }
    }
    throw new Error(`Kết nối thất bại, vui lòng kiểm tra URL và KEY${lastError ? ` (${lastError})` : ''}`);
}