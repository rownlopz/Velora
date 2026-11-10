
const escapeRegex = (text) => {
    if (typeof text !== "string") return "";
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports = escapeRegex;
