const {
    getCategories,
    getCategoryById,
    addCategory,
    updateCategory,
    toggleCategoryStatus,
    softDeleteCategory,
} = require("../../services/admin/categoryService");

const loadCategories = async (req, res) => {
    try {
        const search = req.query.search || "";
        const page = Number(req.query.page) || 1;

        const result = await getCategories({ search, page, limit: 10 });

        let editCategory = null;
        if (req.query.edit) {
            const editResult = await getCategoryById(req.query.edit);
            if (editResult.success) editCategory = editResult.category;
        }

        res.render("admin/categories", {
            categories: result.categories,
            search,
            currentPage: result.currentPage,
            totalPages: result.totalPages,
            totalCategories: result.totalCategories,
            editCategory,
            error: req.query.error || null,
        });
    } catch (error) {
        console.error("Load Categories Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const addCategoryController = async (req, res) => {
    try {
        const { name, status } = req.body;
        const isActive = status === "active";

        const result = await addCategory({ name, isActive });

        if (!result.success) {
            const params = new URLSearchParams({ error: result.message });
            return res.redirect(`/admin/categories?${params.toString()}`);
        }

        res.redirect("/admin/categories");
    } catch (error) {
        console.error("Add Category Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const updateCategoryController = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { name, status } = req.body;
        const isActive = status === "active";

        const result = await updateCategory(categoryId, { name, isActive });

        if (!result.success) {
            const params = new URLSearchParams({ error: result.message, edit: categoryId });
            return res.redirect(`/admin/categories?${params.toString()}`);
        }

        res.redirect("/admin/categories");
    } catch (error) {
        console.error("Update Category Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const toggleCategoryStatusController = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { search = "", page = 1 } = req.body;

        const result = await toggleCategoryStatus(categoryId);

        if (!result.success) {
            return res.status(404).send(result.message);
        }

        const params = new URLSearchParams({ search, page });
        res.redirect(`/admin/categories?${params.toString()}`);
    } catch (error) {
        console.error("Toggle Category Status Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const deleteCategoryController = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { search = "", page = 1 } = req.body;

        const result = await softDeleteCategory(categoryId);

        if (!result.success) {
            return res.status(404).send(result.message);
        }

        const params = new URLSearchParams({ search, page });
        res.redirect(`/admin/categories?${params.toString()}`);
    } catch (error) {
        console.error("Delete Category Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = {
    loadCategories,
    addCategoryController,
    updateCategoryController,
    toggleCategoryStatusController,
    deleteCategoryController,
};
