const transporter = require("../config/nodemailer");

const sendOtpEmail = async (email, otp, usecase = "VERIFY_EMAIL") => {
    let subject = "Verify your Velora Account";
    let title = "Email Verification";
    let text = "Use the verification code below to complete your registration.";

    if (usecase === "RESET_PASSWORD") {
        subject = "Reset Your Velora Password";
        title = "Password Reset";
        text = "Use the verification code below to reset your password.";
    } else if (usecase === "CHANGE_EMAIL") {
        subject = "Confirm Your New Email Address";
        title = "Change Email";
        text = "Use the verification code below to confirm this new email address.";
    }

    const mailOptions = {
        from: `"Velora" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        html: `
            <div style="
                max-width:600px;
                margin:auto;
                padding:40px;
                font-family:Arial,sans-serif;
                border:1px solid #e5e5e5;
                border-radius:12px;
            ">
                <h1 style="text-align:center;">
                    VELORA
                </h1>
                <h2 style="text-align:center;">
                    ${title}
                </h2>
                <p style="text-align:center;color:#666;">
                    ${text}
                </p>
                <div
                    style="
                        text-align:center;
                        font-size:36px;
                        letter-spacing:10px;
                        font-weight:bold;
                        margin:30px 0;
                    ">
                    ${otp}
                </div>
                <p style="text-align:center;color:#888;">
                    This code expires in
                    <strong>1 minute</strong>.
                </p>
                <hr>
                <p
                    style="
                        text-align:center;
                        color:#999;
                        font-size:13px;
                    ">
                    If you didn't request this,
                    please ignore this email.
                </p>
            </div>
        `
    };

    await transporter.sendMail(mailOptions);
};

module.exports = sendOtpEmail;