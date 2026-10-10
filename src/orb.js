import * as config from './config.js';
import * as engine from './engine.js';
import * as cardwriter from './cardwriter.js';
import { openPanel } from './panel.js';
import { ORB_AVATAR_DATA_URI } from './orb-avatar.js';

const ORB_ID = 'ruby_analyzer_orb';
const DRAG_THRESHOLD = 6;
const ORB_DEFAULT_SIZE = 60;

function getOrbSize() {
    return config.clampOrbSize(config.getUi()?.orbSize ?? ORB_DEFAULT_SIZE);
}

/** Áp dụng kích thước quả cầu lơ lửng theo cài đặt (Huy hiệu và viền thu phóng theo tỷ lệ) */
function applySize(orb) {
    const size = getOrbSize();
    orb.style.width = `${size}px`;
    orb.style.height = `${size}px`;
    const badge = orb.querySelector('.ruby-orb-badge');
    if (badge) {
        const badgeSize = Math.max(14, Math.round(size * 0.37));
        const border = size < 44 ? 2 : 3;
        badge.style.width = `${badgeSize}px`;
        badge.style.height = `${badgeSize}px`;
        badge.style.borderWidth = `${border}px`;
        const svg = badge.querySelector('svg');
        if (svg) svg.style.width = svg.style.height = `${Math.max(8, Math.round(badgeSize * 0.5))}px`;
    }
}

const BADGE_ICONS = {
    idle: '<svg viewBox="0 0 24 24" fill="#14161f"><circle cx="12" cy="12" r="5"/></svg>',
    armed: '<svg viewBox="0 0 24 24" fill="none" stroke="#14161f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>',
    working: '<svg viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="12" r="6"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    cardwriting: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
};

let dragState = null;
let bubbleEl = null;
let bubbleTimer = null;
let lastBubbleStep = null;

function defaultPosition() {
    const size = getOrbSize();
    return {
        x: Math.max(12, window.innerWidth - size - 24),
        y: Math.min(window.innerHeight - 180, Math.max(120, window.innerHeight * 0.55)),
    };
}

function applyPosition(orb, pos) {
    const pad = getOrbSize() + 8;
    orb.style.left = `${Math.max(4, Math.min(window.innerWidth - pad, pos.x))}px`;
    orb.style.top = `${Math.max(4, Math.min(window.innerHeight - pad, pos.y))}px`;
}

function badgeState(engineState) {
    const cw = cardwriter.getState();
    if (cw.active && cw.busy) return 'cardwriting';
    if (engineState.running) return 'working';
    if (engineState.lastError || cw.lastError) return 'error';
    if (cw.active) return 'cardwriting';
    if (engineState.armed) return 'armed';
    return 'idle';
}

function setStatus(orb, engineState) {
    const badge = orb.querySelector('.ruby-orb-badge');
    if (!badge) return;
    const cw = cardwriter.getState();
    const state = badgeState(engineState);
    badge.dataset.state = state;
    badge.innerHTML = BADGE_ICONS[state] || BADGE_ICONS.idle;
    if (cw.active && cw.busy) {
        orb.title = `RUBY đang viết thẻ... ${cw.stepId || ''} (Đang xử lý cờ hoàn thành/chuyển bước)`;
    } else if (cw.active) {
        orb.title = `Phiên viết thẻ RUBY · Bước hiện tại ${cw.stepId || '—'} ${cw.stepName || ''} (Nhấp để mở bảng viết thẻ)`;
    } else if (engineState.running) {
        orb.title = `RUBY đang phân tích... ${engineState.charName}`;
    } else if (engineState.lastError || cw.lastError) {
        orb.title = `Lỗi RUBY: ${engineState.lastError || cw.lastError}`;
    } else if (engineState.armed) {
        const pos = engineState.cycleLength > 0 ? `${engineState.position}/${engineState.cycleLength}` : '-';
        orb.title = `RUBY đang chạy · ${engineState.charName} · AI phản hồi ${engineState.aiCount} · Vị trí chu kỳ ${pos} (Nhấp để mở bảng)`;
    } else {
        orb.title = 'RUBY đang chờ (Không có nhân vật, chưa cấu hình nhiệm vụ hoặc chưa liên kết thẻ nhân vật) — Nhấp để mở bảng';
    }
}

// ---------- Bong bóng hướng dẫn bước viết thẻ ----------

/** Văn bản hướng dẫn gốc -> HTML: Khối rào ``` chuyển thành <pre> (Tự động xuống dòng ngang), dòng thường giữ nguyên ngắt dòng */
function guideToHtml(guide) {
    const parts = String(guide || '').split(/```/);
    // Chỉ số chẵn = Văn bản thường (Bao gồm thẻ HTML nội trang), Chỉ số lẻ = Nội dung khối rào
    return parts.map((part, i) => {
        if (i % 2 === 1) {
            let body = part.replace(/^[a-zA-Z]*\r?\n/, '');
            body = body.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
            return `<pre>${body.trim()}</pre>`;
        }
        return part.split(/\r?\n/).join('<br>');
    }).join('');
}

function showStepBubble(stepId) {
    // Thu gọn bong bóng của bước trước đó: Ngay cả khi bước mới không có văn bản hướng dẫn (Step 5-8) cũng phải đảm bảo bong bóng cũ đã được đóng
    hideStepBubble();
    const step = cardwriter.getStep(stepId);
    if (!step || !step.guide) return;
    const orb = document.getElementById(ORB_ID);
    if (!orb) return;

    bubbleEl = document.createElement('div');
    bubbleEl.id = 'ruby_cw_bubble';
    bubbleEl.innerHTML = `
        <span class="cw-bubble-close">✕</span>
        <div class="cw-bubble-title">${stepId === 'Overview' ? '🏁' : '✍️'} ${stepId === 'Overview' ? '' : stepId + ' · '}${step.name}</div>
        <div class="cw-bubble-body">${guideToHtml(step.guide)}</div>`;
    // Hiển thị trước nhưng giữ trạng thái vô hình, để đo kích thước thực (Dưới display:none, getBoundingClientRect đều trả về 0,
    // do đó việc giới hạn cạnh trước đây không bao giờ có tác dụng, bong bóng sau khi hiện mới bay ra khỏi màn hình)
    bubbleEl.style.display = 'block';
    bubbleEl.style.visibility = 'hidden';
    document.body.appendChild(bubbleEl);

    // Định vị: Ưu tiên bên phải quả cầu lơ lửng, tiếp theo là trái, trên, dưới; Toàn bộ quá trình đều giới hạn trong mép viewport,
    // và tránh đè lên chính quả cầu (Nếu không bong bóng che mất quả cầu sẽ dẫn đến "kẹt cứng")
    const MARGIN = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const orbRect = orb.getBoundingClientRect();
    const bubbleRect = bubbleEl.getBoundingClientRect();
    const fits = (l, t) =>
        l >= MARGIN && t >= MARGIN &&
        l + bubbleRect.width <= vw - MARGIN &&
        t + bubbleRect.height <= vh - MARGIN;
    const overlapsOrb = (l, t) =>
        l < orbRect.right && l + bubbleRect.width > orbRect.left &&
        t < orbRect.bottom && t + bubbleRect.height > orbRect.top;

    const candidates = [
        { l: orbRect.right + 12, t: orbRect.top - 8 },              // Bên phải
        { l: orbRect.left - bubbleRect.width - 12, t: orbRect.top - 8 }, // Bên trái
        { l: orbRect.left, t: orbRect.top - bubbleRect.height - 12 },    // Phía trên
        { l: orbRect.left, t: orbRect.bottom + 12 },               // Phía dưới
    ];
    let pos = candidates.find((p) => fits(p.l, p.t) && !overlapsOrb(p.l, p.t));
    if (!pos) pos = candidates.find((p) => fits(p.l, p.t));
    if (!pos) {
        // Viewport quá nhỏ không chứa đủ: Giới hạn bốn góc, đảm bảo hoàn toàn nằm trong màn hình
        pos = {
            l: Math.max(MARGIN, Math.min(vw - bubbleRect.width - MARGIN, orbRect.right + 12)),
            t: Math.max(MARGIN, Math.min(vh - bubbleRect.height - MARGIN, orbRect.top - 8)),
        };
        // Vẫn đè lên quả cầu thì dịch lên trên để tránh
        if (overlapsOrb(pos.l, pos.t)) {
            const above = pos.t - bubbleRect.height - 12;
            if (above >= MARGIN) pos.t = above;
        }
    }
    bubbleEl.style.left = `${pos.l}px`;
    bubbleEl.style.top = `${pos.t}px`;
    bubbleEl.style.visibility = 'visible';

    // details sau khi mở/đóng sẽ thay đổi chiều cao: Giới hạn lại vào trong viewport (Bắt sự kiện toggle, nó không sủi bọt)
    bubbleEl.addEventListener('toggle', () => {
        const r = bubbleEl?.getBoundingClientRect();
        if (!r) return;
        if (r.bottom > vh - MARGIN) bubbleEl.style.top = `${Math.max(MARGIN, vh - r.height - MARGIN)}px`;
        if (r.right > vw - MARGIN) bubbleEl.style.left = `${Math.max(MARGIN, vw - r.width - MARGIN)}px`;
    }, true);

    // Thiết lập an toàn: Nhấp vào vị trí bất kỳ trên bong bóng để đóng (Nút ✕ cũng có tác dụng), phòng ngừa chạm nhầm và che khuất.
    // Ngoại lệ: Không đóng khi mở/đóng details, hoặc khi đang kéo chọn văn bản.
    bubbleEl.addEventListener('click', (e) => {
        if (e.target.closest?.('details, details > *, a')) return;
        if (String(window.getSelection?.() || '') !== '') return;
        e.stopPropagation();
        hideStepBubble();
    });
    bubbleEl.querySelector('.cw-bubble-close')?.addEventListener('click', hideStepBubble);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideStepBubble, 60000);
}

function hideStepBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    if (bubbleEl) {
        bubbleEl.remove();
        bubbleEl = null;
    }
}

/** Làm mới trạng thái ẩn/hiện của quả cầu theo cấu hình UI hiện tại (Lưu bảng điều khiển / Nút bật tắt thanh tiện ích đều gọi) */
export function refreshVisibility() {
    const el = document.getElementById(ORB_ID);
    if (el) el.classList.toggle('hidden', !!config.getUi().orbHidden);
}

export function ensureOrb() {
    if (document.getElementById(ORB_ID)) return;

    const orb = document.createElement('div');
    orb.id = ORB_ID;
    orb.innerHTML = `
        <span class="ruby-orb-avatar" style="background-image:url('${ORB_AVATAR_DATA_URI}')"></span>
        <span class="ruby-orb-badge" data-state="idle">${BADGE_ICONS.idle}</span>
    `;
    document.body.appendChild(orb);
    applySize(orb);

    const ui = config.getUi();
    applyPosition(orb, (Number.isFinite(ui.orbX) && Number.isFinite(ui.orbY)) ? { x: ui.orbX, y: ui.orbY } : defaultPosition());
    refreshVisibility();

    orb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            originX: parseFloat(orb.style.left),
            originY: parseFloat(orb.style.top),
            moved: false,
        };
        try { orb.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
    });

    orb.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dragState.moved) {
            dragState.moved = true;
            hideStepBubble(); // Thu gọn bong bóng hướng dẫn khi kéo thả, tránh lưu bóng và che khuất
        }
        applyPosition(orb, { x: dragState.originX + dx, y: dragState.originY + dy });
    });

    orb.addEventListener('pointerup', (e) => {
        if (!dragState) return;
        const moved = dragState.moved;
        const pos = { x: parseFloat(orb.style.left), y: parseFloat(orb.style.top) };
        dragState = null;
        try { orb.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        if (moved) {
            config.saveUi({ orbX: pos.x, orbY: pos.y });
        } else {
            // Khi phiên viết thẻ đang kích hoạt, nhấp vào sẽ đi thẳng đến tab viết thẻ, nếu không sẽ mở bảng điều khiển chính
            if (cardwriter.getState().active) {
                openPanel('cardwriter');
            } else {
                openPanel();
            }
        }
    });

    orb.addEventListener('pointercancel', () => {
        dragState = null;
    });

    window.addEventListener('resize', () => {
        const el = document.getElementById(ORB_ID);
        if (el) applyPosition(el, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
        hideStepBubble();
    });

    // Làm mới bằng event-driven khi bảng điều khiển lưu cấu hình UI (Thay thế cho polling): Ẩn/hiện + Kích thước
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById(ORB_ID);
        if (el) applySize(el);
        refreshVisibility();
    });

    setStatus(orb, engine.getEngineState());
    engine.onStateChange((engineState) => {
        const el = document.getElementById(ORB_ID);
        if (el) setStatus(el, engineState);
    });
    cardwriter.onStateChange((s) => {
        const el = document.getElementById(ORB_ID);
        if (el) setStatus(el, engine.getEngineState());
        // Hiển thị bong bóng hướng dẫn khi chuyển bước (Có thể đóng, tự động thu gọn sau 60 giây); Thu gọn bong bóng và reset cờ khi kết thúc phiên/đang rảnh
        if (!s.active || !s.stepId) {
            lastBubbleStep = null;
            hideStepBubble();
            return;
        }
        if (s.stepId !== lastBubbleStep) {
            lastBubbleStep = s.stepId;
            showStepBubble(s.stepId);
        }
    });
}