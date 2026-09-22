const Category = require("../../models/product/categoryModel");
const slugify = require("../../utils/slugify");

/**
 * List categories for the admin table. Excludes soft-deleted categories
 * (they should never appear here, or anywhere user-facing) and supports
 * search + pagination + newest-first sorting, all combined in one query
 * so they work correctly together.
 */
const getCategories = async ({ search = "", page = 1, limit = 10 }) => {
    const skip = (page - 1) * limit;

    const query = { isDeleted: false };

    if (search.trim()) {
        query.name = { $regex: search.trim(), $options: "i" };
    }

    const [categories, totalCategories] = await Promise.all([
        Category.find(query)
            .sort({ createdAt: -1 }) // newest first
            .skip(skip)
            .limit(limit),

        Category.countDocuments(query),
    ]);

    return {
        categories,
        totalCategories,
        totalPages: Math.ceil(totalCategories / limit),
        currentPage: page,
    };
};

const getCategoryById = async (categoryId) => {
    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) {
        return { success: false, message: "Category not found" };
    }
    return { success: true, category };
};

/**
 * Checks for a duplicate ACTIVE (non-deleted) category by name or slug.
 * A soft-deleted category's name should never block a new category from
 * reusing that name — uniqueness only matters among categories that are
 * actually visible/in-use.
 */
const findDuplicate = async (name, slug, excludeId = null) => {
    const query = {
        isDeleted: false,
        $or: [
            { name: { $regex: `^${name.trim()}$`, $options: "i" } },
            { slug },
        ],
    };

    if (excludeId) {
        query._id = { $ne: excludeId };
    }

    return Category.findOne(query);
};

const addCategory = async ({ name, isActive }) => {
    const trimmedName = name.trim();
    const slug = slugify(trimmedName);

    if (!trimmedName) {
        return { success: false, message: "Category name is required" };
    }

    const duplicate = await findDuplicate(trimmedName, slug);
    if (duplicate) {
        return { success: false, message: "A category with this name already exists" };
    }

    const category = await Category.create({
        name: trimmedName,
        slug,
        isActive: isActive !== undefined ? isActive : true,
    });

    return { success: true, category };
};

const updateCategory = async (categoryId, { name, isActive }) => {
    const trimmedName = name.trim();
    const slug = slugify(trimmedName);

    if (!trimmedName) {
        return { success: false, message: "Category name is required" };
    }

    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) {
        return { success: false, message: "Category not found" };
    }

    const duplicate = await findDuplicate(trimmedName, slug, categoryId);
    if (duplicate) {
        return { success: false, message: "A category with this name already exists" };
    }

    category.name = trimmedName;
    category.slug = slug;
    if (isActive !== undefined) category.isActive = isActive;
    await category.save();

    return { success: true, category };
};

const toggleCategoryStatus = async (categoryId) => {
    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) {
        return { success: false, message: "Category not found" };
    }

    category.isActive = !category.isActive;
    await category.save();

    return { success: true, category };
};

/**
 * Soft delete: the document is never physically removed from MongoDB.
 * It's marked isDeleted + deletedAt, and every user-facing / admin-listing
 * query filters isDeleted: false, so it simply stops appearing anywhere.
 */
const softDeleteCategory = async (categoryId) => {
    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) {
        return { success: false, message: "Category not found" };
    }

    category.isDeleted = true;
    category.deletedAt = new Date();
    category.isActive = false;
    await category.save();

    return { success: true };
};

module.exports = {
    getCategories,
    getCategoryById,
    addCategory,
    updateCategory,
    toggleCategoryStatus,
    softDeleteCategory,
};
