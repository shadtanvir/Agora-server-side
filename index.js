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
    // collections
    const tagsCollection = client.db("agora").collection("tags");
    const postsCollection = client.db("agora").collection("posts");
    const usersCollection = client.db("agora").collection("users");
    const commentsCollection = client.db("agora").collection("comments");
    const announcementsCollection = client.db("agora").collection("announcements");

    // Verify admin middleware

    const verifyAdmin = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      // console.log(user.role)
      if (user.role === "admin") {
        next();
      }
      else {
        return res.status(403).send({ message: 'Unauthorized Access!' });

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
            badge
          })


        }

        res.status(201).json({ message: "User stored successfully", user });
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // GET all users with optional search by username)
    app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const search = req.query.search || "";

        const excludeEmail = req.decoded.email;

        const query = {
          ...(search ? { name: { $regex: search, $options: "i" } } : {}),
          email: { $ne: excludeEmail },
        };

        const users = await usersCollection.find(query).toArray();
        res.json(users);
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });


    // get user role
    app.get("/get-user-role", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
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
        console.error("Error fetching user role:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });




    // count user's posts
    app.get("/posts/count/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const count = await postsCollection.countDocuments({ authorEmail: email });
        res.json({ count });
      } catch (error) {
        console.error("Error counting posts:", error);
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
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // PATCH make a user admin
    app.patch("/users/make-admin/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "admin" } }
        );
        res.json(result);
      } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });
    // Ban user
    app.patch("/users/ban/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { banned: true } }
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ message: "Failed to ban user" });
      }
    });



    // -------- TAGS API -------- //

    // Get all tags
    app.get("/tags",
      async (req, res) => {
        try {
          const tags = await tagsCollection.find({}).sort({ name: 1 }).toArray();
          res.send(tags);
        } catch (err) {
          console.error("Failed to fetch tags:", err);
          res.status(500).send({ error: "Failed to fetch tags" });
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
          tag: { $regex: q, $options: "i" }
        }).sort({ createdAt: -1 });

        res.json(posts);
      } catch (error) {
        res.status(500).json({ message: "Error searching posts", error });
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
            localField: "title",
            foreignField: "postTitle",
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
        console.error(err);
        res.status(500).send({ error: "Failed to fetch posts" });
      }
    });

    // Get posts by an user
    app.get("/posts/by-user", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ message: "Email required" });

        const posts = await postsCollection.find({ authorEmail: email }).toArray();
        res.json(posts);
      } catch (error) {
        console.error("Error fetching user posts:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

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

    // Delete a post
    app.delete("/posts/:id", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const { id } = req.params;
        const { email } = req.query;

        const post = await postsCollection.findOne({ _id: new ObjectId(id) });
        if (!post) return res.status(404).json({ message: "Post not found" });

        // Ensure only the author can delete
        if (post.authorEmail !== email) {
          return res.status(403).json({ message: "Unauthorized" });
        }

        const result = await postsCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error("Error deleting post:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });



    // Add a post
    app.post("/posts", async (req, res) => {
      try {
        const { authorImage, authorName, authorEmail, title, description, tag } = req.body;

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

        res.status(201).json({ message: "Post created successfully", postId: result.insertedId });
      } catch (error) {
        console.error("Error creating post:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });


    /**
 * PATCH /api/posts/:id/upvote
 */
    app.patch("/posts/:id/upvote", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const id = req.params.id;
        await postsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { upVote: 1 } }
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to upvote" });
      }
    });

    /**
     * PATCH /api/posts/:id/downvote
     */
    app.patch("/posts/:id/downvote", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const id = req.params.id;
        await postsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { downVote: 1 } }
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to downvote" });
      }
    });

    //  Search posts by tag with pagination
    app.get("/posts/search", async (req, res) => {
      try {
        const q = req.query.q || "";
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const skip = (page - 1) * limit;

        const filter =
          q.trim().length > 0 ? { tag: { $regex: q, $options: "i" } } : {};

        const total = await postsCollection.countDocuments(filter);

        const posts = await postsCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        // attach comments count
        for (let p of posts) {
          const count = await commentsCollection.countDocuments({
            postId: p._id.toString(),
          });
          p.commentsCount = count;
        }

        res.json({
          data: posts,
          totalPages: Math.ceil(total / limit),
          currentPage: page,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to search posts" });
      }
    });


    // Comments collection API

    //Add a new comment (user must be logged in)

    app.post("/posts/:id/comments", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const id = req.params.id;
        const email = req.query.email;
        const { userId, userName, text } = req.body;

        if (!userId || !text) {
          return res.status(400).json({ error: "Missing user or text" });
        }

        const newComment = {
          postId: id,
          userId,
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
    });

    // get comments by post
    app.get("/comments/:postId", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
      try {
        const { postId } = req.params;
        const comments = await commentsCollection.find({ postId }).toArray();
        res.json(comments);
      } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // report a comment
    app.patch("/comments/report/:id", verifyFirebaseToken, verifyTokenEmail, async (req, res) => {
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
        console.error("Error reporting comment:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // Get all reported comments
    app.get("/comments/reported", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const reportedComments = await commentsCollection
          .find({ reported: true })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(reportedComments);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch reported comments" });
      }
    });

    // Admin action: delete comment
    app.delete("/comments/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const result = await commentsCollection.deleteOne({ _id: new ObjectId(id) });
      res.json(result);
    });

    // Admin action: dismiss report (keep comment, clear report flag)
    app.patch("/comments/dismiss/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const result = await commentsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { reported: false, feedback: "" } }
      );
      res.json(result);
    });





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
    app.post("/announcements", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { authorImage, authorName, title, description } = req.body;
        const newAnnouncement = {
          authorImage,
          authorName,
          title,
          description,
          createdAt: new Date()
        };
        const result = await announcementsCollection.insertOne(newAnnouncement);
        res.json(result);
      } catch (error) {
        console.error("Error creating announcement:", error);
        res.status(500).json({ message: "Internal Server Error" });
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








