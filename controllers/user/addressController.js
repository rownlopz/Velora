const {
    getAddresses,
    getAddressById,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
} = require("../../services/user/addressService");

const loadAddresses = async (req, res) => {
    try {
        const result = await getAddresses(req.session.userId);
        res.render("user/address-dashboard", {
            title: "My Addresses",
            addresses: result.addresses || [],
        });
    } catch (error) {
        console.error("Load Addresses Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadAddAddress = (req, res) => {
    res.render("user/address-edit", {
        title: "Add Address",
        address: {},
        errors: {},
        isEdit: false,
    });
};

const loadEditAddress = async (req, res) => {
    try {
        const result = await getAddressById(req.session.userId, req.params.addressId);
        if (!result.success) {
            return res.redirect("/addresses");
        }

        res.render("user/address-edit", {
            title: "Edit Address",
            address: result.address,
            errors: {},
            isEdit: true,
        });
    } catch (error) {
        console.error("Load Edit Address Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const validateAddressBody = (body) => {
    const errors = {};
    const { firstName, lastName, addressLine1, phone, pinCode, city, state, country } = body;

    if (!firstName || !firstName.trim()) errors.firstName = "First name is required";
    if (!lastName || !lastName.trim()) errors.lastName = "Last name is required";
    if (!addressLine1 || !addressLine1.trim()) errors.addressLine1 = "Address line 1 is required";
    if (!phone || !/^[0-9]{10}$/.test(phone.trim())) errors.phone = "Enter a valid 10-digit phone number";
    if (!pinCode || !/^[0-9]{6}$/.test(String(pinCode).trim())) errors.pinCode = "Enter a valid 6-digit pincode";
    if (!city || !city.trim()) errors.city = "City is required";
    if (!state || !state.trim()) errors.state = "State is required";
    if (!country || !country.trim()) errors.country = "Country is required";

    return Object.keys(errors).length > 0 ? errors : null;
};

const addAddressController = async (req, res) => {
    try {
        const errors = validateAddressBody(req.body);
        if (errors) {
            return res.status(400).render("user/address-edit", {
                title: "Add Address",
                address: req.body,
                errors,
                isEdit: false,
            });
        }

        await addAddress(req.session.userId, {
            ...req.body,
            isDefault: req.body.isDefault === "on" || req.body.isDefault === true,
        });

        return res.redirect("/addresses");
    } catch (error) {
        console.error("Add Address Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const updateAddressController = async (req, res) => {
    try {
        const errors = validateAddressBody(req.body);
        if (errors) {
            return res.status(400).render("user/address-edit", {
                title: "Edit Address",
                address: { ...req.body, _id: req.params.addressId },
                errors,
                isEdit: true,
            });
        }

        const result = await updateAddress(req.session.userId, req.params.addressId, {
            ...req.body,
            isDefault: req.body.isDefault === "on" || req.body.isDefault === true,
        });

        if (!result.success) {
            return res.status(404).send(result.message);
        }

        return res.redirect("/addresses");
    } catch (error) {
        console.error("Update Address Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const deleteAddressController = async (req, res) => {
    try {
        const result = await deleteAddress(req.session.userId, req.params.addressId);
        if (!result.success) {
            return res.status(404).send(result.message);
        }
        return res.redirect("/addresses");
    } catch (error) {
        console.error("Delete Address Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const setDefaultAddressController = async (req, res) => {
    try {
        const result = await setDefaultAddress(req.session.userId, req.params.addressId);
        if (!result.success) {
            return res.status(404).send(result.message);
        }
        const redirectTo = req.body.redirectTo === "profile-edit" ? "/profile/edit" : "/addresses";
        return res.redirect(redirectTo);
    } catch (error) {
        console.error("Set Default Address Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = {
    loadAddresses,
    loadAddAddress,
    loadEditAddress,
    addAddressController,
    updateAddressController,
    deleteAddressController,
    setDefaultAddressController,
};
