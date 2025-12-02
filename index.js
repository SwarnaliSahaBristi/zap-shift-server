const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./dragon-news-auth-7bc5f-firebase-adminsdk-fbsvc-201f826be6.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

//middleware
app.use(express.json());
app.use(cors());

//verify Firebase token
const verifyFbToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorize access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorize access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster2002.1tfbne8.mongodb.net/?appName=Cluster2002`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    //middle admin before allowing admin activity
    //must be used after verifyFbToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("_").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    //user related apis
    app.get("/users", verifyFbToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = {$regex: searchText, $options: 'i'}
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = userCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExist = await userCollection.findOne({ email });

      if (userExist) {
        return res.send({ message: "user exist" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.patch(
      "/users/:id/role",
      verifyFbToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    //parcels api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = {$in: ['driver_assigned','rider_arriving']};
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }
      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.get("/parcels/delivery-status/stats", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
          },
        },
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      //parcel creaated time
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;

      logTracking(trackingId, "parcel_created");

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    //todo:rename this to the specific like /parcels/:id/assign
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(query, updatedDoc);

      //update rider info
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };

      //log tracking
      logTracking(trackingId, "driver_assigned");

      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };
      if (deliveryStatus === "parcel_delivered") {
        //update rider info
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdatedDoc
        );
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc);
      //log tracking
      logTracking(trackingId, deliveryStatus);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    //payment related apis

    //new
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please pay for : ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          trackingId: paymentInfo.trackingId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    //old
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: `Please pay for : ${paymentInfo.parcelName}`,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     mode: "payment",
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //       parcelName: paymentInfo.parcelName,
    //     },
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log('session id', sessionId)
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log('session retrieve', session)
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = session.metadata.trackingId;

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
          },
        };
        const result = await parcelsCollection.updateOne(query, update);
        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };
        const resultPayment = await paymentCollection.insertOne(payment);

        logTracking(trackingId, "parcel_paid");

        return res.send({
          success: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }
      return res.send({ success: false });
    });

    //payment related apis
    app.get("/payments", verifyFbToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      // console.log('headers',req.headers)

      if (email) {
        query.customerEmail = email;

        //check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //riders related apis
    app.get("/rider", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.riderDistrict = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/riders/delivery-per-day", async (req, res) => {
      const email = req.query.email;
      //aggregate on parcel
      const pipeline = [
        {
          $match: {
            riderEmail: email,
            deliveryStatus: "parcel_delivered",
          },
        },
        {
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "parcel_trackings",
          },
        },
        {
          $unwind: "$parcel_trackings",
        },
        {
          $match: {
            "parcel_trackings.status": "parcel_delivered",
          },
        },
        {
          // convert timestamp to YYYY-MM-DD string
          $addFields: {
            deliveryDay: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$parcel_trackings.createdAt",
              },
            },
          },
        },
        {
          // group by date
          $group: {
            _id: "$deliveryDay",
            deliveredCount: { $sum: 1 },
          },
        },
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post("/rider", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.patch("/rider/:id", verifyFbToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, updatedDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser
        );
      }

      res.send(result);
    });

    //tracking related apis

    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap shift is starting...");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
