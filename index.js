const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
// const { ObjectId } = require("mongodb");


const { MongoClient, ServerApiVersion, ObjectId, ChangeStream } = require("mongodb");
dotenv.config();

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');

const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});





const app = express();
const PORT = process.env.PORT || 5000;


// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gshi3kg.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;


// MongoDB Connection
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});


// middleware


const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;
  // console.log(authHeader);
  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).send({ message: 'Unauthorized Access!' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    // console.log(decoded.email);
    req.decoded = decoded;
    next();
  }
  catch (error) {
    return res.status(401).send({ message: 'Unauthorized Access!' });

  }
};
const verifyTokenEmail = async (req, res, next) => {
  // console.log(req.decoded.email);
  // console.log(req.query.email);
  if (req.query.email !== req.decoded.email) {
    return res.status(403).send({ message: 'Forbidden Access!' });

  }
  next();

}



async function run() {
  try {
    // await client.connect();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

  } finally {
  }
}

run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("Server is running!");
});








