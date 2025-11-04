const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");

// const { ObjectId } = require("mongodb");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  ChangeStream,
} = require("mongodb");
dotenv.config();

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);

const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gshi3kg.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
  if (!authHeader || !authHeader.startsWith("Bearer")) {
    return res.status(401).json({ message: "Unauthorized Access!" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized Access!" });
  }
};

const verifyTokenEmail = async (req, res, next) => {
  // console.log(req.decoded.email);
  // console.log(req.query.email);
  if (req.query.email !== req.decoded.email) {
    return res.status(403).send({ message: "Forbidden Access!" });
  }
  next();
};

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");
    // collections
    const tagsCollection = client.db("agora").collection("tags");
    const postsCollection = client.db("agora").collection("posts");
    const usersCollection = client.db("agora").collection("users");
    const commentsCollection = client.db("agora").collection("comments");
    const announcementsCollection = client
      .db("agora")
      .collection("announcements");

    // Payment related API

    /* Stripe instance
   Create payment intent*/
    app.post(
      "/create-payment-intent",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { amount, user } = req.body;

          if (!amount || amount <= 0) {
            return res.status(400).send({ error: "Invalid amount" });
          }

          // Convert to smallest currency unit (e.g. cents for USD, poisha for BDT)
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100, // if amount is in dollars/taka
            currency: "usd", // change to "bdt" if you want taka
            metadata: {
              email: user.email,
              name: user.name,
            },
          });

          res.send({ clientSecret: paymentIntent.client_secret });
        } catch (err) {
          res.status(500).send({ error: err.message });
        }
      }
    );

    // Verify admin middleware

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email; // 🔑 use req.decoded
        if (!email) {
          return res.status(401).json({ message: "Unauthorized" });
        }

        const user = await usersCollection.findOne({ email });

        if (user?.role !== "admin") {
          return res.status(403).json({ message: "Forbidden" });
        }
        next();
      } catch (err) {
        res.status(500).json({ message: "Server error in verifyAdmin" });
      }
    };
    // Verify ban middleware
    const verifyNotBanned = async (req, res, next) => {
      try {
        const email = req.decoded?.email;
        if (!email) {
          return res.status(401).json({ message: "Unauthorized" });
        }

        const user = await usersCollection.findOne({ email });
        if (user?.banned) {
          return res.status(403).json({ message: "Your account is banned." });
        }

        next();
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    };

    // Users Api

    //  Register or Login User (store in DB if not exists)
    app.post("/register", async (req, res) => {
      try {
        const { email, name, photoURL, badge, role } = req.body;

        if (!email) {
          return res.status(400).json({ message: "Email is required" });
        }

        // Check if user already exists
        let user = await usersCollection.findOne({ email });

        if (!user) {
          // Create new user with Bronze badge
          usersCollection.insertOne({
            name,
            email,
            photoURL,
            role,
            badge,
            banned: false,
          });
        }

        res.status(201).json({ message: "User stored successfully", user });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // Upgrade badge after payment
    app.patch(
      "/users/upgrade/:email",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { email } = req.params;

          const result = await usersCollection.updateOne(
            { email },
            { $set: { badge: "gold" } }
          );

          res.json({ success: true, result });
        } catch (error) {
          res.status(500).json({ message: "Failed to upgrade badge" });
        }
      }
    );

    // GET all users with optional search by username)
    app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const search = req.query.search || "";
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const excludeEmail = req.decoded.email;

        const query = {
          ...(search ? { name: { $regex: search, $options: "i" } } : {}),
          email: { $ne: excludeEmail },
        };

        const total = await usersCollection.countDocuments(query);

        const users = await usersCollection
          .find(query)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        res.json({
          users,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // get user role
    app.get(
      "/get-user-role",
      verifyFirebaseToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).json({ message: "Email is required" });
          }

          const user = await usersCollection.findOne({ email });
          if (!user) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json({ role: user.role });
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // GET a user
    app.get(
      "/get-user",
      verifyFirebaseToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).json({ message: "Email is required" });
          }

          const dbUser = await usersCollection.findOne({ email });
          if (!dbUser) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json(dbUser);
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // count user's posts
    app.get("/posts/count/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const count = await postsCollection.countDocuments({
          authorEmail: email,
        });
        res.json({ count });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // Find user and 3 recent posts
    app.get("/users/:email", async (req, res) => {
      try {
        const { email } = req.params;

        // Find user
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        // Get last 3 posts
        const posts = await postsCollection
          .find({ authorEmail: email })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();

        res.json({ user, recentPosts: posts });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // PATCH make a user admin
    app.patch(
      "/users/make-admin/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: "admin" } }
          );
          res.json(result);
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // Ban a user
    app.patch(
      "/users/ban/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { banned: true } }
        );
        res.json(result);
      }
    );
    // Unban a user
    app.patch(
      "/users/unban/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { banned: false } }
        );
        res.json(result);
      }
    );

    // Toggle ban\unban a user
    app.patch(
      "/users/:id/ban",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { banned } = req.body; // should be true OR false

          if (typeof banned !== "boolean") {
            return res
              .status(400)
              .json({ message: "banned must be a boolean" });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { banned: banned } }
          );

          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .json({ message: "User not found or not updated" });
          }

          res.json({ success: true, banned });
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // Featured Members

    app.get("/featured-members", async (req, res) => {
      try {
        const featuredMembers = await usersCollection
          .aggregate([
            // Join posts with users
            {
              $lookup: {
                from: "posts",
                localField: "email",
                foreignField: "authorEmail",
                as: "userPosts",
              },
            },
            // Calculate total post count for each user
            {
              $addFields: {
                totalPosts: { $size: "$userPosts" },
              },
            },
            // Filter out banned users and only show active ones
            {
              $match: {
                banned: false,
                $or: [
                  { badge: "gold" }, // Special members
                  { totalPosts: { $gt: 0 } }, // Active contributors
                ],
              },
            },
            // Sort: Gold members first, then by total posts
            {
              $sort: { badge: -1, totalPosts: -1 },
            },
            // Limit result for front-end
            {
              $limit: 10,
            },
            // Return only needed fields
            {
              $project: {
                _id: 1,
                name: 1,
                email: 1,
                photoURL: 1,
                badge: 1,
                totalPosts: 1,
                role: 1,
              },
            },
          ])
          .toArray();

        res.send(featuredMembers);
      } catch (error) {
        console.error("Error fetching featured members:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // User overview
    app.get("/overview", verifyFirebaseToken, async (req, res) => {
  try {
    const { email } = req.query;
  
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const posts = await postsCollection
      .find({ authorEmail: email })
      .sort({ createdAt: -1 })
      .toArray();
    const comments = await commentsCollection
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    const stats = {
      posts: posts.length,
      comments: comments.length,
      likes: posts.reduce((acc, p) => acc + (p.upVote || 0), 0),
      recentPosts: posts.slice(0, 5),
      recentComments: comments.slice(0, 5),
      user,
    };

    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

    // -------- TAGS API -------- //

    // Get all tags
    app.get("/tags", async (req, res) => {
      try {
        const tags = await tagsCollection.find({}).sort({ name: 1 }).toArray();
        res.send(tags);
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // Add a tag
    app.post("/tags", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { name } = req.body;
        const result = await tagsCollection.insertOne({ name });
        res.json(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to add tag" });
      }
    });

    // Search by tag
    app.get("/search", async (req, res) => {
      try {
        const { q } = req.query; // search keyword from frontend

        if (!q) {
          return res.status(400).json({ message: "Search query is required" });
        }

        // Case-insensitive search in tag field
        const posts = await Post.find({
          tag: { $regex: q, $options: "i" },
        }).sort({ createdAt: -1 });

        res.json(posts);
      } catch (error) {
        res.status(500).json({ message: "Error searching posts", error });
      }
    });

    // Trending tags
    app.get("/trending-tags", verifyFirebaseToken, async (req, res) => {
      try {
        const tags = await postsCollection
          .aggregate([
            { $group: { _id: "$tag", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $project: { name: "$_id", count: 1, _id: 0 } },
          ])
          .toArray();
        res.send(tags);
      } catch (error) {
        res.status(500).send({ error: "Failed to load trending tags" });
      }
    });

    // Posts related API

    // Get posts with sorting + pagination
    app.get("/posts", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const sortBy = req.query.sortBy || "newest"; // "newest" or "popularity"

        const skip = (page - 1) * limit;

        let pipeline = [];

        // Attach comments count
        pipeline.push({
          $lookup: {
            from: "comments",
            localField: "_id",
            foreignField: "postId",
            as: "commentsData",
          },
        });

        pipeline.push({
          $addFields: {
            commentsCount: { $size: "$commentsData" },
            voteDifference: { $subtract: ["$upVote", "$downVote"] },
          },
        });

        // Sorting logic
        if (sortBy === "popularity") {
          pipeline.push({ $sort: { voteDifference: -1 } });
        } else {
          pipeline.push({ $sort: { createdAt: -1 } });
        }

        // Pagination
        pipeline.push({ $skip: skip });
        pipeline.push({ $limit: limit });

        // Total count for pagination
        const totalDocs = await postsCollection.countDocuments();

        const posts = await postsCollection.aggregate(pipeline).toArray();

        res.send({
          data: posts,
          currentPage: page,
          totalPages: Math.ceil(totalDocs / limit),
        });
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch posts" });
      }
    });
    // fetch all the post of a user + pagination
    app.get(
      "/posts/by-user",
      verifyFirebaseToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const { email, page = 1, limit = 5 } = req.query;
          if (!email)
            return res.status(400).json({ message: "Email required" });

          const skip = (parseInt(page) - 1) * parseInt(limit);

          const posts = await postsCollection
            .find({ authorEmail: email })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();

          const total = await postsCollection.countDocuments({
            authorEmail: email,
          });

          res.json({
            posts,
            total,
            hasMore: page * limit < total,
          });
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // fetch single post by id
    app.get("/posts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const post = await postsCollection.findOne({ _id: new ObjectId(id) });
        if (!post) return res.status(404).json({ error: "Post not found" });

        // Fetch comments for this post
        const comments = await commentsCollection
          .find({ postId: id })
          .sort({ createdAt: -1 })
          .toArray();

        res.json({ ...post, comments });
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch post details" });
      }
    });

    // Top contributors
    app.get("/top-contributors", verifyFirebaseToken, async (req, res) => {
      try {
        const contributors = await postsCollection
          .aggregate([
            {
              $group: {
                _id: "$authorEmail",
                name: { $first: "$authorName" },
                image: { $first: "$authorImage" },
                posts: { $sum: 1 },
                votes: { $sum: { $add: ["$upVote", "$downVote"] } },
              },
            },
            { $sort: { posts: -1, votes: -1 } },
            { $limit: 6 },
          ])
          .toArray();

        res.send(contributors);
      } catch (error) {
        res.status(500).send({ error: "Failed to load contributors" });
      }
    });

    // Recent posts
    app.get("/recent-posts", verifyFirebaseToken, async (req, res) => {
      try {
        const posts = await postsCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(10)
          .project({
            title: 1,
            authorName: 1,
            authorImage: 1,
            tag: 1,
            createdAt: 1,
          })
          .toArray();

        // format timeAgo
        const now = new Date();
        const formattedPosts = posts.map((post) => {
          const diffMs = now - new Date(post.createdAt);
          const diffMins = Math.floor(diffMs / 60000);
          const timeAgo =
            diffMins < 60
              ? `${diffMins}m ago`
              : diffMins < 1440
              ? `${Math.floor(diffMins / 60)}h ago`
              : `${Math.floor(diffMins / 1440)}d ago`;

          return { ...post, timeAgo };
        });

        res.status(200).json(formattedPosts);
      } catch (error) {
        console.error("Error fetching recent posts:", error);
        res.status(500).json({ message: "Failed to fetch recent posts" });
      }
    });

    // Delete a post
    app.delete(
      "/posts/:id",
      verifyFirebaseToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { email } = req.query;

          const post = await postsCollection.findOne({ _id: new ObjectId(id) });
          if (!post) return res.status(404).json({ message: "Post not found" });

          // Ensure only the author can delete
          if (post.authorEmail !== email) {
            return res.status(403).json({ message: "Unauthorized" });
          }

          const result = await postsCollection.deleteOne({
            _id: new ObjectId(id),
          });
          res.json(result);
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // Add a post
    app.post(
      "/posts",
      verifyFirebaseToken,
      verifyNotBanned,
      async (req, res) => {
        try {
          const {
            authorImage,
            authorName,
            authorEmail,
            title,
            description,
            tag,
          } = req.body;

          if (!authorEmail || !title || !description || !tag) {
            return res.status(400).json({ message: "Missing required fields" });
          }

          const newPost = {
            authorImage,
            authorName,
            authorEmail,
            title,
            description,
            tag,
            upVote: 0,
            downVote: 0,
            createdAt: new Date(),
          };

          const result = await postsCollection.insertOne(newPost);

          res.status(201).json({
            message: "Post created successfully",
            postId: result.insertedId,
          });
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // Vote (upvote, downvote)

    app.patch(
      "/posts/:id/vote",
      verifyFirebaseToken,
      verifyNotBanned,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { email, type } = req.query;

          if (!["upvote", "downvote"].includes(type)) {
            return res.status(400).json({ error: "Invalid vote type" });
          }

          const postId = new ObjectId(id);
          const post = await postsCollection.findOne({ _id: postId });
          if (!post) return res.status(404).json({ error: "Post not found" });

          const existingVote = post.votes?.find((v) => v.email === email);

          let updateOps = {};

          if (!existingVote) {
            // Case 1: New vote
            updateOps = {
              $inc: { [type === "upvote" ? "upVote" : "downVote"]: 1 },
              $push: { votes: { email, type } },
            };
          } else if (existingVote.type === type) {
            // Case 2: Remove same vote
            updateOps = {
              $inc: { [type === "upvote" ? "upVote" : "downVote"]: -1 },
              $pull: { votes: { email } },
            };
          } else {
            // Case 3: Switch vote (no arrayFilters, just $pull + $push)
            updateOps = {
              $inc: {
                [type === "upvote" ? "upVote" : "downVote"]: 1,
                [type === "upvote" ? "downVote" : "upVote"]: -1,
              },
              $pull: { votes: { email } },
              $push: { votes: { email, type } },
            };
          }

          const result = await postsCollection.findOneAndUpdate(
            { _id: postId },
            updateOps,
            { returnDocument: "after" }
          );

          res.json(result.value);
        } catch (err) {
          // console.error(" Vote error:", err);
          res
            .status(500)
            .json({ error: "Failed to vote", details: err.message });
        }
      }
    );

    // search post + pagination

    app.get("/search/posts", async (req, res) => {
      try {
        const q = req.query.q || "";
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const skip = (page - 1) * limit;

        // filter by tag (case-insensitive regex)
        const filter =
          q.trim().length > 0 ? { tag: { $regex: q, $options: "i" } } : {};

        const total = await postsCollection.countDocuments(filter);

        const posts = await postsCollection
          .aggregate([
            { $match: filter },
            {
              $lookup: {
                from: "comments",
                localField: "_id",
                foreignField: "postId",
                as: "commentsData",
              },
            },
            {
              $addFields: {
                commentsCount: { $size: "$commentsData" },
                voteDifference: { $subtract: ["$upVote", "$downVote"] },
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
          ])
          .toArray();

        res.json({
          data: posts,
          currentPage: page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to search posts" });
      }
    });

    // Comments collection API

    //Add a new comment (user must be logged in)

    app.post(
      "/posts/:id/comments",
      verifyFirebaseToken,
      verifyNotBanned,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const id = req.params.id;
          const email = req.query.email;
          const { userId, userName, text } = req.body;

          if (!userId || !text) {
            return res.status(400).json({ error: "Missing user or text" });
          }

          const newComment = {
            postId: new ObjectId(id),
            userId: new ObjectId(userId),
            userName,
            userEmail: email,
            text,
            reported: false,
            feedback: "",
            createdAt: new Date(),
          };

          await commentsCollection.insertOne(newComment);
          res.json({ success: true, comment: newComment });
        } catch (err) {
          res.status(500).json({ error: "Failed to add comment" });
        }
      }
    );

    // get comments by post with pagination
    app.get("/comments/:postId", async (req, res) => {
      try {
        const { postId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;

        const skip = (page - 1) * limit;

        const comments = await commentsCollection
          .find({ postId: new ObjectId(postId) })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await commentsCollection.countDocuments({
          postId: new ObjectId(postId),
        });

        res.json({
          comments,
          total,
          hasMore: page * limit < total,
        });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // report a comment
    app.patch(
      "/comments/report/:id",
      verifyFirebaseToken,
      verifyTokenEmail,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { feedback } = req.body; // user-selected feedback

          const result = await commentsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                reported: true,
                feedback: feedback,
              },
            }
          );

          res.json(result);
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );
    // GET Reported comments
    app.get(
      "/reported/comments",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const page = parseInt(req.query.page) || 1;
          const limit = parseInt(req.query.limit) || 10;
          const skip = (page - 1) * limit;

          const query = { reported: true };

          const total = await commentsCollection.countDocuments(query);

          const reportedComments = await commentsCollection
            .find(query)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 }) // newest first
            .toArray();

          res.send({
            comments: reportedComments,
            total,
            page,
            totalPages: Math.ceil(total / limit),
          });
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to fetch reported comments" });
        }
      }
    );

    // Delete comment
    app.delete(
      "/comments/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const result = await commentsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      }
    );

    // Dismiss report
    app.patch(
      "/comments/dismiss/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const result = await commentsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { reported: false, feedback: "" } }
        );
        res.json(result);
      }
    );

    // Announcements API
    // Get announcements
    app.get("/announcements", async (req, res) => {
      try {
        const announcements = await announcementsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.send(announcements);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch announcements" });
      }
    });
    // Count total announcements
    app.get("/announcements/count", async (req, res) => {
      try {
        const count = await announcementsCollection.countDocuments();
        res.send({ count });
      } catch (err) {
        res.status(500).send({ error: "Failed to count announcements" });
      }
    });
    // POST new announcement
    app.post(
      "/announcements",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { authorImage, authorName, title, description } = req.body;
          const newAnnouncement = {
            authorImage,
            authorName,
            title,
            description,
            createdAt: new Date(),
          };
          const result = await announcementsCollection.insertOne(
            newAnnouncement
          );
          res.json(result);
        } catch (error) {
          res.status(500).json({ message: "Internal Server Error" });
        }
      }
    );

    // Admin stats API

    app.get(
      "/admin/stats",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const posts = await postsCollection.countDocuments();
          const comments = await commentsCollection.countDocuments();
          const users = await usersCollection.countDocuments();

          res.json({ posts, comments, users });
        } catch (error) {
          res.status(500).json({ message: "Failed to fetch stats" });
        }
      }
    );

    // Community Impacts

    app.get("/community-impact", async (req, res) => {
      try {
        const totalMembers = await usersCollection.countDocuments({
          banned: false,
        });
        const totalPosts = await postsCollection.countDocuments();
        const posts = await postsCollection.find({}).toArray();

        const totalUpvotes = posts.reduce(
          (sum, post) => sum + (post.upVote || 0),
          0
        );
        const contributorEmails = [...new Set(posts.map((p) => p.authorEmail))];
        const topContributors = contributorEmails.length;

        res.send({
          totalMembers,
          totalPosts,
          totalUpvotes,
          topContributors,
        });
      } catch (error) {
        console.error("Error fetching community impact:", error);
        res.status(500).send({ message: "Failed to fetch community impact" });
      }
    });

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
