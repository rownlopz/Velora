/**
 * Safely escapes special regular expression characters for literal matching in MongoDB regex.
 * Prevents regex injection and syntax errors with characters like '[', '(', '+', etc.
 */
const escapeRegex = (text) => {
    if (typeof text !== "string") return "";
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports = escapeRegex;
