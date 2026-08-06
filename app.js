const express = require("express");
const dotenv = require("dotenv");
const path = require("path");

const connectDB = require("./config/db");

const adminRoute = require("./routes/admin/adminRoute");
const userRoute = require("./routes/user/userRoute");

dotenv.config();

const app = express();
//Connect Database
connectDB();
//Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true}));
//ViewEngine
app.set("view engine", "ejs");
//Static Folder
app.use(express.static(path.join(__dirname,"public")));
//Routes
app.use("/", userRoute);
app.use("/admin", adminRoute);

app.listen(process.env.PORT || 3000, () =>{
    console.log(`Server running on http://localhost:${ process.env.PORT || 3000}`);
})
