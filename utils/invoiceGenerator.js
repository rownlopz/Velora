const PDFDocument = require("pdfkit");

/**
 * Generates and streams a professional, multipage-safe PDF tax invoice
 * using authoritative purchase snapshots and current order adjustments.
 */
const generateInvoicePdf = (order, res) => {
    const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename=invoice-${order.orderNumber}.pdf`
    );

    doc.pipe(res);

    const isOrderCancelled = order.orderStatus === "CANCELLED";

    const printHeader = (isFirstPage = true) => {
        if (isFirstPage) {
            // Header Branding
            doc
                .fontSize(22)
                .font("Helvetica-Bold")
                .fillColor("#111111")
                .text("VELORA", 50, 45)
                .fontSize(8.5)
                .font("Helvetica")
                .fillColor("#666666")
                .text("Contemporary Luxury & Timeless Fashion", 50, 72)
                .text("www.velorastore.com | support@velora.com", 50, 84);

            // Invoice Meta (Right side)
            doc
                .fontSize(15)
                .font("Helvetica-Bold")
                .fillColor(isOrderCancelled ? "#991b1b" : "#111111")
                .text(isOrderCancelled ? "TAX INVOICE (CANCELLED)" : "TAX INVOICE", 310, 45, { align: "right", width: 235 })
                .fontSize(8.5)
                .font("Helvetica")
                .fillColor("#444444")
                .text(`Order ID: ${order.orderNumber}`, 310, 68, { align: "right", width: 235 })
                .text(`Invoice No: INV-${order.orderNumber}`, 310, 81, { align: "right", width: 235 })
                .text(
                    `Order Date: ${new Date(order.placedAt || order.createdAt).toLocaleDateString("en-IN")}`,
                    310,
                    94,
                    { align: "right", width: 235 }
                )
                .text(`Payment: ${order.paymentMethod} (${order.paymentStatus})`, 310, 107, { align: "right", width: 235 })
                .text(`Status: ${order.orderStatus.replace(/_/g, " ")}`, 310, 120, { align: "right", width: 235 });

            let headerBottom = 138;
            if (isOrderCancelled) {
                doc.rect(50, 136, 495, 22).fillAndStroke("#fee2e2", "#fca5a5");
                const cancelText = `ORDER CANCELLED on ${order.cancelledAt ? new Date(order.cancelledAt).toLocaleDateString("en-IN") : "N/A"}${order.cancellationReason ? " | Reason: " + order.cancellationReason : ""}`;
                doc
                    .fontSize(8)
                    .font("Helvetica-Bold")
                    .fillColor("#991b1b")
                    .text(cancelText, 55, 142, { width: 485, align: "center" });
                headerBottom = 166;
            }

            doc.moveTo(50, headerBottom).lineTo(545, headerBottom).strokeColor("#e5e7eb").lineWidth(1).stroke();

            // Shipping Address with safe line wrapping
            const shipTop = headerBottom + 10;
            doc
                .fontSize(9)
                .font("Helvetica-Bold")
                .fillColor("#111111")
                .text("SHIPPING & BILLING ADDRESS:", 50, shipTop)
                .font("Helvetica")
                .fontSize(8.5)
                .fillColor("#333333")
                .text(`${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`, 50, shipTop + 14)
                .text(
                    `${order.shippingAddress.addressLine1}${order.shippingAddress.addressLine2 ? ", " + order.shippingAddress.addressLine2 : ""}`,
                    50,
                    shipTop + 26,
                    { width: 350 }
                )
                .text(
                    `${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pinCode}`,
                    50,
                    shipTop + 38
                )
                .text(
                    `${order.shippingAddress.country} | Phone: ${order.shippingAddress.phone}`,
                    50,
                    shipTop + 50
                );

            return shipTop + 68;
        } else {
            // Continuation header for multipage documents
            doc
                .fontSize(9)
                .font("Helvetica")
                .fillColor("#666666")
                .text(`VELORA TAX INVOICE — Order #${order.orderNumber} (Continued)`, 50, 35)
                .moveTo(50, 48)
                .lineTo(545, 48)
                .strokeColor("#e5e7eb")
                .lineWidth(0.8)
                .stroke();
            return 58;
        }
    };

    const printTableHeader = (yPos) => {
        doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor("#e5e7eb").lineWidth(0.8).stroke();
        doc
            .fontSize(8)
            .font("Helvetica-Bold")
            .fillColor("#111111")
            .text("ITEM DESCRIPTION & STATUS", 50, yPos + 5)
            .text("QTY", 310, yPos + 5, { width: 40, align: "center" })
            .text("UNIT PRICE", 360, yPos + 5, { width: 85, align: "right" })
            .text("AMOUNT", 455, yPos + 5, { width: 90, align: "right" });
        doc.moveTo(50, yPos + 18).lineTo(545, yPos + 18).strokeColor("#111111").lineWidth(0.8).stroke();
        return yPos + 24;
    };

    let currentY = printHeader(true);
    currentY = printTableHeader(currentY);

    const checkPageBreak = (neededHeight) => {
        if (currentY + neededHeight > 720) {
            doc.addPage();
            currentY = printHeader(false);
            currentY = printTableHeader(currentY);
        }
    };

    // Render Items
    order.items.forEach((item) => {
        const itemStatus = (item.status || "PENDING").toUpperCase();
        const isItemCancelled = itemStatus === "CANCELLED" || isOrderCancelled;
        const isItemReturned = itemStatus === "RETURNED";

        let statusTag = "";
        if (isItemCancelled) statusTag = " [CANCELLED]";
        else if (isItemReturned) statusTag = " [RETURNED]";
        else if (itemStatus === "RETURN_REQUESTED") statusTag = " [RETURN REQUESTED]";
        else if (itemStatus === "RETURN_APPROVED") statusTag = " [RETURN ACCEPTED]";
        else if (itemStatus === "RETURN_REJECTED") statusTag = " [RETURN REJECTED]";
        else if (itemStatus === "OUT_FOR_DELIVERY") statusTag = " [OUT FOR DELIVERY]";
        else if (itemStatus !== "DELIVERED" && itemStatus !== "PENDING" && itemStatus !== "PROCESSING") {
            statusTag = ` [${itemStatus.replace(/_/g, " ")}]`;
        }

        const itemDesc = `${item.productName}${item.color ? " (" + item.color + ")" : ""}${item.size ? " - Size: " + item.size : ""}${item.sku ? " [SKU: " + item.sku + "]" : ""}${statusTag}`;

        doc.fontSize(8).font("Helvetica");
        const descHeight = doc.heightOfString(itemDesc, { width: 250 });
        let extraHeight = 0;
        if (isItemCancelled && item.cancellationReason) {
            extraHeight += 12;
        }
        if (item.adminFeedback) {
            extraHeight += 12;
        }

        const rowHeight = Math.max(descHeight, 14) + extraHeight + 8;
        checkPageBreak(rowHeight);

        // Print row details
        doc
            .fontSize(8)
            .font(isItemCancelled ? "Helvetica-Oblique" : isItemReturned ? "Helvetica-Oblique" : "Helvetica")
            .fillColor(isItemCancelled ? "#991b1b" : isItemReturned ? "#c2410c" : "#222222")
            .text(itemDesc, 50, currentY, { width: 250 })
            .text(String(item.quantity), 310, currentY, { width: 40, align: "center" })
            .text(`INR ${item.unitPrice.toLocaleString("en-IN")}`, 360, currentY, { width: 85, align: "right" });

        let amountText = `INR ${item.lineTotal.toLocaleString("en-IN")}`;
        if (isItemCancelled) {
            amountText = "INR 0 (Void)";
        } else if (isItemReturned) {
            amountText = "INR 0 (Returned)";
        }

        doc.text(amountText, 455, currentY, { width: 90, align: "right" });

        let subY = currentY + Math.max(descHeight, 14);

        if (isItemCancelled && item.cancellationReason) {
            doc
                .fontSize(7.5)
                .fillColor("#b91c1c")
                .text(`Reason: ${item.cancellationReason}`, 60, subY, { width: 240 });
            subY += 12;
        }

        if (item.adminFeedback) {
            doc
                .fontSize(7.5)
                .fillColor("#4b5563")
                .text(`Admin Feedback: ${item.adminFeedback}`, 60, subY, { width: 240 });
            subY += 12;
        }

        currentY += rowHeight;
        doc.moveTo(50, currentY - 2).lineTo(545, currentY - 2).strokeColor("#f3f4f6").lineWidth(0.5).stroke();
    });

    // Summary Section
    checkPageBreak(130);

    doc.moveTo(50, currentY + 2).lineTo(545, currentY + 2).strokeColor("#e5e7eb").lineWidth(1).stroke();
    currentY += 12;

    const summaryLabelX = 330;
    const summaryValX = 455;
    const summaryValWidth = 90;

    const originalSubtotal = order.pricing?.originalSubtotal !== undefined
        ? order.pricing.originalSubtotal
        : (order.pricing?.subtotal || 0);

    const originalShipping = order.pricing?.originalShippingFee !== undefined
        ? order.pricing.originalShippingFee
        : (order.pricing?.shippingFee || 0);

    doc
        .fontSize(8.5)
        .font("Helvetica")
        .fillColor("#555555")
        .text("Original Subtotal:", summaryLabelX, currentY)
        .text(`INR ${originalSubtotal.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });

    currentY += 15;
    doc
        .text("Shipping Fee:", summaryLabelX, currentY)
        .text(
            originalShipping === 0 ? "FREE" : `INR ${originalShipping.toLocaleString("en-IN")}`,
            summaryValX,
            currentY,
            { width: summaryValWidth, align: "right" }
        );

    if (order.pricing?.discount > 0) {
        currentY += 15;
        doc
            .text("Discount:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.discount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.cancellationDeduction > 0) {
        currentY += 15;
        doc
            .fillColor("#b91c1c")
            .text("Cancelled Items Adjustment:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.cancellationDeduction.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.returnCredit > 0) {
        currentY += 15;
        doc
            .fillColor("#c2410c")
            .text("Return Credit Adjustment:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.returnCredit.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    currentY += 14;
    doc.moveTo(summaryLabelX, currentY).lineTo(545, currentY).strokeColor("#111111").lineWidth(0.8).stroke();
    currentY += 6;

    const finalPayable = order.pricing?.currentPayable !== undefined
        ? order.pricing.currentPayable
        : (isOrderCancelled ? 0 : (order.pricing?.totalAmount || 0));

    doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor(isOrderCancelled ? "#991b1b" : "#000000")
        .text("Total Payable / Paid:", summaryLabelX, currentY)
        .text(`INR ${finalPayable.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });

    // Dynamic Safe Footer (Guaranteed not to overlap)
    if (currentY + 60 > 770) {
        doc.addPage();
        currentY = 50;
    } else {
        currentY = Math.max(currentY + 40, 750);
    }

    doc
        .fontSize(7.5)
        .font("Helvetica")
        .fillColor("#888888")
        .text("This is an electronically generated invoice and does not require a physical signature.", 50, currentY, { align: "center", width: 495 })
        .text("Thank you for choosing VELORA Store. For customer support, visit www.velorastore.com", 50, currentY + 12, { align: "center", width: 495 });

    doc.end();
};

module.exports = { generateInvoicePdf };
