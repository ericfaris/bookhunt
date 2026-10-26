'use strict';

// The BookHunt email design kit, shared by every email the app sends (book
// notifications, reader invites/announcements, the radar digest): a warm cream
// backdrop, a white rounded card, a navy header band carrying the 🔎 BookHunt
// wordmark, orange accents, and the "Sent with ♥ by Eric" footer.
// Email-client-safe: tables + inline styles only (no flex/grid, no <style>).

// Brand palette (inline; email clients ignore :root/vars).
const ACCENT = '#f1592a';
const NAVY = '#1c2a56';
const INK = '#1c2a56';
const MUTED = '#6b727e';
const PAPER = '#f6f1e7';

function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The BookHunt card shell: header band + body + footer, matching the notify
 *  email. `body` is the inner rows HTML; `footerNote` is optional small print
 *  (e.g. the unsubscribe line) shown above the signature. `signature` lets
 *  operator-facing emails (e.g. the new-release digest) swap the reader one. */
function emailShell(subHeader, body, footerNote = '', signature = 'Sent with ♥ by Eric via BookHunt') {
  return `
  <div style="margin:0;padding:24px 12px;background:${PAPER};
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr><td align="center">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0"
               style="width:540px;max-width:540px;background:#ffffff;border-radius:16px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(28,42,86,0.14)">

          <tr><td style="background:${NAVY};padding:16px 28px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:20px;line-height:1;padding-right:9px">🔎</td>
              <td>
                <p style="margin:0;color:#ffffff;font-size:16px;font-weight:800;letter-spacing:0.2px">
                  Book<span style="color:${ACCENT}">Hunt</span>
                </p>
                <p style="margin:0;color:#aeb6d6;font-size:11px;font-weight:600">find your book.</p>
              </td>
            </tr></table>
          </td></tr>

          <tr><td style="padding:18px 28px 0">
            <p style="margin:0;color:${ACCENT};font-size:13px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase">
              ${subHeader}
            </p>
          </td></tr>

          ${body}

          <tr><td style="padding:16px 28px;background:#faf7f0;border-top:1px solid #ece5d6">
            ${footerNote ? `<p style="margin:0 0 6px;color:#9a93a1;font-size:11px">${footerNote}</p>` : ''}
            <p style="margin:0;color:#9a93a1;font-size:11px">${signature}</p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </div>`;
}

/** An orange call-to-action button row. */
function ctaRow(href, label, pad = '20px 28px 4px') {
  return `<tr><td style="padding:${pad}">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;
       text-decoration:none;font-size:15px;font-weight:700;padding:13px 26px;border-radius:10px">
      ${label}
    </a>
  </td></tr>`;
}

module.exports = { ACCENT, NAVY, INK, MUTED, PAPER, escapeHtml, emailShell, ctaRow };
