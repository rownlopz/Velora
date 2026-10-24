const Offer = require("../../models/product/offerModel");
const Coupon = require("../../models/order/couponModel");

const SHIPPING_THRESHOLD = 1000;
const SHIPPING_FLAT_FEE = 100;

const calculateShippingFee = (subtotal) => {
    if (!subtotal || subtotal <= 0) return 0;
    return subtotal >= SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
};

const getBestActiveOffer = async (productId, categoryId, now = new Date(), regularPrice = null) => {
    if (!productId) return null;

    const query = {
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [
            { offerType: "PRODUCT", productId: productId },
            { offerType: "PRODUCT", productIds: productId },
            ...(categoryId ? [{ offerType: "CATEGORY", categoryId: categoryId }] : []),
        ],
    };

    const offers = await Offer.find(query).lean();
    if (!offers || offers.length === 0) return null;

    let bestOffer = null;
    let highestSavings = -1;

    for (const off of offers) {
        let savings = 0;
        if (regularPrice != null && Number.isFinite(Number(regularPrice)) && Number(regularPrice) > 0) {
            const regPrice = Number(regularPrice);
            if (off.discountType === "PERCENTAGE") {
                const rawDiscount = (regPrice * off.discountValue) / 100;
                savings = off.maxDiscount != null ? Math.min(rawDiscount, off.maxDiscount) : rawDiscount;
            } else if (off.discountType === "FLAT") {
                savings = Math.min(regPrice, off.discountValue);
            }
        } else {
            // When regularPrice is not known, compare discount rates / values as fallback
            savings = off.discountValue;
        }

        if (savings > highestSavings) {
            highestSavings = savings;
            bestOffer = off;
        } else if (savings === highestSavings && bestOffer) {
            // Tie-break: product-specific offer wins over category offer
            if (off.offerType === "PRODUCT" && bestOffer.offerType === "CATEGORY") {
                bestOffer = off;
            }
        }
    }

    return bestOffer;
};

const calculateItemPrice = (variant, product, offer = null) => {
    const regularPrice = Number(variant?.regularPrice) || 0;
    const baseSalePrice = variant?.salePrice != null && Number.isFinite(Number(variant.salePrice))
        ? Number(variant.salePrice)
        : null;

    let offerDiscount = 0;
    let appliedOffer = null;

    if (offer && regularPrice > 0) {
        if (offer.discountType === "PERCENTAGE") {
            const rawDiscountPaise = Math.round((regularPrice * 100 * offer.discountValue) / 100);
            const maxDiscountPaise = offer.maxDiscount != null ? Math.round(offer.maxDiscount * 100) : null;
            const offerDiscountPaise = maxDiscountPaise != null
                ? Math.min(rawDiscountPaise, maxDiscountPaise)
                : rawDiscountPaise;
            offerDiscount = offerDiscountPaise / 100;
        } else if (offer.discountType === "FLAT") {
            offerDiscount = Math.min(regularPrice, Math.round(Number(offer.discountValue) * 100) / 100);
        }

        if (offerDiscount > 0) {
            appliedOffer = {
                offerId: offer._id,
                name: offer.name,
                offerType: offer.offerType,
                discountType: offer.discountType,
                discountValue: offer.discountValue,
                unitDiscount: offerDiscount,
            };
        }
    }

    const priceAfterOffer = Math.max(0, Math.round((regularPrice - offerDiscount) * 100) / 100);
    let effectiveUnitPrice = priceAfterOffer;

    if (baseSalePrice != null && baseSalePrice < effectiveUnitPrice) {
        effectiveUnitPrice = baseSalePrice;
        appliedOffer = null;
    }

    const totalDiscount = Math.max(0, Math.round((regularPrice - effectiveUnitPrice) * 100) / 100);

    return {
        regularPrice,
        baseSalePrice,
        effectiveUnitPrice,
        unitOfferDiscount: appliedOffer ? offerDiscount : 0,
        unitSaleDiscount: !appliedOffer ? Math.max(0, Math.round((regularPrice - effectiveUnitPrice) * 100) / 100) : 0,
        totalReduction: totalDiscount,
        appliedOffer,
    };
};


const getAuthoritativeItemPrice = async (variant, product, now = new Date()) => {
    if (!variant) return { displayPrice: 0, regularPrice: 0, effectiveUnitPrice: 0, appliedOffer: null };
    const regPrice = Number(variant.regularPrice) || 0;
    const catId = product?.categoryId?._id || product?.categoryId || null;
    const prodId = product?._id || variant.productId || null;

    const bestOffer = await getBestActiveOffer(prodId, catId, now, regPrice);
    const pricing = calculateItemPrice(variant, product, bestOffer);

    return {
        displayPrice: pricing.effectiveUnitPrice,
        regularPrice: pricing.regularPrice,
        baseSalePrice: pricing.baseSalePrice,
        effectiveUnitPrice: pricing.effectiveUnitPrice,
        appliedOffer: pricing.appliedOffer,
    };
};

const TAX_RATE = 0.05; // 5% fixed tax rate

const isItemAvailable = (item) => {
    if (!item) return false;
    if (item.isAvailable === false) return false;
    if (item.productUnlisted === true) return false;
    if (item.variant && item.variant.isActive === false) return false;
    if (item.variant && typeof item.variant.stock === "number" && item.variant.stock <= 0) {
        if (item.isAvailable !== true) return false;
    }
    return true;
};


const allocateCouponAndTax = (items, totalCouponDiscount, taxRate = TAX_RATE) => {
    if (!items || items.length === 0) return items || [];

    // Eligible items are those where isAvailable !== false and lineTotal > 0
    const totalSubtotalPaise = Math.round(
        items.reduce((sum, i) => {
            if (i.isAvailable === false) return sum;
            return sum + (Number(i.lineTotal) || 0);
        }, 0) * 100
    );
    const couponPaise = Math.round((Number(totalCouponDiscount) || 0) * 100);

    // 1. Coupon allocation in integer paise
    let allocatedCouponSumPaise = 0;
    const allocatedItems = items.map((item) => {
        const isEligible = item.isAvailable !== false && (Number(item.lineTotal) || 0) > 0;
        const itemLineTotalPaise = isEligible ? Math.round((Number(item.lineTotal) || 0) * 100) : 0;
        let itemCouponSharePaise = 0;
        if (isEligible && totalSubtotalPaise > 0 && couponPaise > 0) {
            itemCouponSharePaise = Math.floor((itemLineTotalPaise * couponPaise) / totalSubtotalPaise);
        }
        allocatedCouponSumPaise += itemCouponSharePaise;
        return {
            ...item,
            isAvailable: item.isAvailable !== false,
            isEligible,
            itemLineTotalPaise,
            itemCouponSharePaise,
        };
    });

    // Distribute remainder coupon paise to largest line total eligible items
    let remainderCouponPaise = couponPaise - allocatedCouponSumPaise;
    if (remainderCouponPaise > 0) {
        const sortedIndices = allocatedItems
            .map((item, idx) => ({ idx, total: item.itemLineTotalPaise, isEligible: item.isEligible }))
            .filter((entry) => entry.isEligible && entry.total > 0)
            .sort((a, b) => b.total - a.total);

        for (let i = 0; i < sortedIndices.length && remainderCouponPaise > 0; i++) {
            allocatedItems[sortedIndices[i].idx].itemCouponSharePaise += 1;
            remainderCouponPaise -= 1;
        }
    }

    // 2. Tax calculation and allocation in integer paise
    // Taxable merchandise amount = merchandise subtotal after offers minus coupon discount
    const taxableAmountPaise = Math.max(0, totalSubtotalPaise - couponPaise);
    const totalTaxPaise = Math.round((taxableAmountPaise * Math.round(taxRate * 100)) / 100);

    let allocatedTaxSumPaise = 0;
    allocatedItems.forEach((item) => {
        if (!item.isEligible || item.itemLineTotalPaise === 0) {
            item.itemTaxablePaise = 0;
            item.itemTaxSharePaise = 0;
            return;
        }
        const itemTaxablePaise = Math.max(0, item.itemLineTotalPaise - item.itemCouponSharePaise);
        let itemTaxSharePaise = 0;
        if (taxableAmountPaise > 0 && totalTaxPaise > 0) {
            itemTaxSharePaise = Math.floor((itemTaxablePaise * totalTaxPaise) / taxableAmountPaise);
        }
        item.itemTaxablePaise = itemTaxablePaise;
        item.itemTaxSharePaise = itemTaxSharePaise;
        allocatedTaxSumPaise += itemTaxSharePaise;
    });

    // Distribute remainder tax paise to largest taxable eligible items
    let remainderTaxPaise = totalTaxPaise - allocatedTaxSumPaise;
    if (remainderTaxPaise > 0) {
        const sortedIndices = allocatedItems
            .map((item, idx) => ({ idx, taxable: item.itemTaxablePaise, isEligible: item.isEligible }))
            .filter((entry) => entry.isEligible && entry.taxable > 0)
            .sort((a, b) => b.taxable - a.taxable);

        for (let i = 0; i < sortedIndices.length && remainderTaxPaise > 0; i++) {
            allocatedItems[sortedIndices[i].idx].itemTaxSharePaise += 1;
            remainderTaxPaise -= 1;
        }
    }

    return allocatedItems.map((item) => {
        const isEligible = item.isEligible;
        const allocatedCouponDiscount = isEligible ? item.itemCouponSharePaise / 100 : 0;
        const allocatedTax = isEligible ? item.itemTaxSharePaise / 100 : 0;
        const finalPayable = isEligible ? (item.itemTaxablePaise + item.itemTaxSharePaise) / 100 : 0;
        const lineTotal = isEligible ? (Number(item.lineTotal) || 0) : 0;
        const { itemLineTotalPaise, itemCouponSharePaise, itemTaxablePaise, itemTaxSharePaise, isEligible: _del, ...cleanItem } = item;
        return {
            ...cleanItem,
            lineTotal,
            allocatedCouponDiscount,
            allocatedDiscount: allocatedCouponDiscount,
            allocatedTax,
            finalPayable,
        };
    });
};

const allocateCouponDiscount = (items, totalCouponDiscount) => {
    return allocateCouponAndTax(items, totalCouponDiscount, 0);
};


const calculateCartPricing = async (cartItems, couponCode = "", userId = null) => {
    const now = new Date();
    const pricedItems = [];

    let rawSubtotal = 0; // based on original regular prices
    let effectiveSubtotal = 0; // based on post-offer prices
    let totalOfferDiscount = 0;
    let totalSaleDiscount = 0;

    for (const item of cartItems) {
        const variant = item.variant;
        const product = item.product || {};
        const quantity = Number(item.quantity) || 1;

        const regPrice = Number(variant?.regularPrice) || 0;
        const bestOffer = await getBestActiveOffer(product._id, product.categoryId, now, regPrice);
        const pricing = calculateItemPrice(variant, product, bestOffer);

        const lineRegularTotal = pricing.regularPrice * quantity;
        const lineEffectiveTotal = pricing.effectiveUnitPrice * quantity;

        // Promotional offer discount applies ONLY when an active offer is applied
        const unitOfferDiscount = pricing.appliedOffer ? (Number(pricing.appliedOffer.unitDiscount) || 0) : 0;
        const lineOfferDiscount = unitOfferDiscount * quantity;

        // Normal catalogue sale discount applies when effective unit price is reduced without an active offer
        const unitSaleDiscount = !pricing.appliedOffer ? Math.max(0, pricing.regularPrice - pricing.effectiveUnitPrice) : 0;
        const lineSaleDiscount = unitSaleDiscount * quantity;

        const isEligible = isItemAvailable(item);

        // Only available items contribute to subtotal calculations (Finding 76 & Bug 11)
        if (isEligible) {
            rawSubtotal += lineRegularTotal;
            effectiveSubtotal += lineEffectiveTotal;
            totalOfferDiscount += lineOfferDiscount;
            totalSaleDiscount += lineSaleDiscount;
        }

        pricedItems.push({
            variantId: variant?._id || item.variantId,
            productId: product?._id || item.productId,
            productName: product.name || item.productName || "Product",
            productSlug: product.slug || item.productSlug || "",
            thumbnail: product.thumbnail || item.thumbnail || (variant?.images && variant.images[0]) || "",
            color: variant?.color || item.color || "",
            size: variant?.size || item.size || "",
            sku: variant?.sku || item.sku || "",
            brand: product.brand || item.brand || "",
            categoryId: product.categoryId || item.categoryId || null,
            quantity,
            regularPrice: pricing.regularPrice,
            salePrice: pricing.baseSalePrice,
            originalUnitPrice: pricing.regularPrice,
            effectiveUnitPrice: pricing.effectiveUnitPrice,
            unitPrice: pricing.effectiveUnitPrice,
            priceAtPurchase: pricing.effectiveUnitPrice,
            lineTotal: isEligible ? lineEffectiveTotal : 0,
            regularLineTotal: lineRegularTotal,
            effectiveLineTotal: lineEffectiveTotal,
            isAvailable: isEligible,
            offerId: pricing.appliedOffer ? pricing.appliedOffer.offerId : null,
            offerName: pricing.appliedOffer ? pricing.appliedOffer.name : "",
            offerDiscount: unitOfferDiscount,
            totalOfferDiscount: isEligible ? lineOfferDiscount : 0,
            saleDiscount: unitSaleDiscount,
            totalSaleDiscount: isEligible ? lineSaleDiscount : 0,
            appliedOffer: pricing.appliedOffer,
        });
    }

    // Evaluate Coupon if provided
    let couponDiscount = 0;
    let appliedCoupon = null;
    let couponError = null;

    if (couponCode && typeof couponCode === "string" && couponCode.trim()) {
        const cleanCode = couponCode.trim().toUpperCase();
        const coupon = await Coupon.findOne({
            code: cleanCode,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
        }).lean();

        if (!coupon) {
            const rawCoupon = await Coupon.findOne({ code: cleanCode }).lean();
            if (!rawCoupon) {
                couponError = "Invalid coupon code.";
            } else if (!rawCoupon.isActive) {
                couponError = "This coupon is currently inactive.";
            } else if (now < new Date(rawCoupon.startDate)) {
                couponError = "This coupon is not active yet.";
            } else if (now > new Date(rawCoupon.endDate)) {
                couponError = "This coupon has expired.";
            } else {
                couponError = "Coupon is invalid or has expired.";
            }
        } else if (effectiveSubtotal <= 0) {
            couponError = "Coupon cannot be applied to an empty or unavailable cart.";
        } else if (effectiveSubtotal < (coupon.minPurchase || 0)) {
            couponError = `Coupon requires a minimum purchase of ₹${coupon.minPurchase.toLocaleString("en-IN")}.`;
        } else if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
            couponError = "This coupon has reached its maximum usage limit.";
        } else {
            // Check per-user limit
            if (userId) {
                const userUsage = coupon.usersUsed?.find(
                    (u) => u.userId.toString() === userId.toString()
                );
                if (userUsage && userUsage.usageCount >= (coupon.perUserLimit || 1)) {
                    couponError = "You have already used this coupon the maximum allowed number of times.";
                }
            }

            if (!couponError) {
                if (coupon.discountType === "PERCENTAGE") {
                    const rawCouponPaise = Math.round((effectiveSubtotal * 100 * coupon.discountValue) / 100);
                    const maxCouponPaise = coupon.maxDiscount != null ? Math.round(coupon.maxDiscount * 100) : null;
                    const couponDiscountPaise = maxCouponPaise != null
                        ? Math.min(rawCouponPaise, maxCouponPaise)
                        : rawCouponPaise;
                    couponDiscount = couponDiscountPaise / 100;
                } else if (coupon.discountType === "FLAT") {
                    couponDiscount = Math.min(effectiveSubtotal, Math.round(Number(coupon.discountValue) * 100) / 100);
                }

                appliedCoupon = {
                    couponId: coupon._id,
                    code: coupon.code,
                    discountType: coupon.discountType,
                    discountValue: coupon.discountValue,
                    discountAmount: couponDiscount,
                };
            }
        }
    }

    const subtotalPaise = Math.round(effectiveSubtotal * 100);
    const couponDiscountPaise = Math.round(couponDiscount * 100);
    const taxableAmountPaise = Math.max(0, subtotalPaise - couponDiscountPaise);
    const taxAmountPaise = Math.round((taxableAmountPaise * 5) / 100);
    const shippingFee = calculateShippingFee(effectiveSubtotal);
    const shippingFeePaise = Math.round(shippingFee * 100);

    const totalAmountPaise = Math.max(0, taxableAmountPaise + taxAmountPaise + shippingFeePaise);

    const taxableAmount = taxableAmountPaise / 100;
    const taxAmount = taxAmountPaise / 100;
    const totalAmount = totalAmountPaise / 100;

    // Allocate order-level coupon discount and 5% tax deterministically across items
    const finalItems = allocateCouponAndTax(pricedItems, couponDiscount, TAX_RATE);

    return {
        items: finalItems,
        rawSubtotal,
        subtotal: effectiveSubtotal,
        totalOfferDiscount,
        totalSaleDiscount,
        couponDiscount,
        appliedCoupon,
        couponError,
        taxRate: TAX_RATE,
        taxableAmount,
        taxAmount,
        shippingFee,
        shippingThreshold: SHIPPING_THRESHOLD,
        totalAmount,
    };
};

const calculateOfferSavings = (regularPrice, offer) => {
    if (!offer || !regularPrice || regularPrice <= 0) return 0;
    const regPrice = Number(regularPrice);
    if (offer.discountType === "PERCENTAGE") {
        const rawDiscountPaise = Math.round((regPrice * 100 * offer.discountValue) / 100);
        const maxDiscountPaise = offer.maxDiscount != null ? Math.round(offer.maxDiscount * 100) : null;
        const offerDiscountPaise = maxDiscountPaise != null ? Math.min(rawDiscountPaise, maxDiscountPaise) : rawDiscountPaise;
        return offerDiscountPaise / 100;
    }
    if (offer.discountType === "FLAT") {
        return Math.min(regPrice, Math.round(Number(offer.discountValue) * 100) / 100);
    }
    return 0;
};

module.exports = {
    SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE,
    TAX_RATE,
    calculateShippingFee,
    getBestActiveOffer,
    calculateOfferSavings,
    calculateItemPrice,
    getAuthoritativeItemPrice,
    allocateCouponDiscount,
    allocateCouponAndTax,
    calculateCartPricing,
};
