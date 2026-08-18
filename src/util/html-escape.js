"use strict";

const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => MAP[c]);
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LS_RE = new RegExp(LS, "g");
const PS_RE = new RegExp(PS, "g");

// Escape a JSON string so it is safe to embed inside a <script>...</script> block.
// Breaks </script>, <!--, and Unicode line terminators that would corrupt the parser.
function escapeJsonForScript(json) {
  return String(json)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS_RE, "\\u2028")
    .replace(PS_RE, "\\u2029");
}

module.exports = { escapeHtml, escapeJsonForScript };
