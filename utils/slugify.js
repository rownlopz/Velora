
const slugify = (text) => {
    return text
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumeric chars -> one hyphen
        .replace(/^-+|-+$/g, "");   // trim leading/trailing hyphens
};

module.exports = slugify;
