const transporter = require("../config/nodemailer");

const sendOtpEmail = async (email, otp) => {

    const mailOptions = {

        from: `"Velora" <${process.env.EMAIL_USER}>`,

        to: email,

        subject: "Verify your Velora Account",

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
                    Email Verification
                </h2>

                <p style="text-align:center;color:#666;">
                    Use the verification code below
                    to complete your registration.
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