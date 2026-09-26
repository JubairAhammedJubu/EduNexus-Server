import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// GET /api/events - Read events from MongoDB database
router.get("/events", async (req, res) => {
  try {
    const category = req.query.category ? String(req.query.category) : undefined;
    const where: any = {};
    if (category && category !== "All") {
      where.category = category;
    }

    const events = await (prisma as any).event.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.json({ events });
  } catch (err: any) {
    console.error("[events] list:", err);
    res.status(500).json({ error: err?.message || "Failed to load events" });
  }
});

// POST /api/admin/events - Admin create event in MongoDB events collection
router.post("/admin/events", ...adminOnly, async (req, res) => {
  try {
    const { title, category, startDate, location, audience, description } = req.body;

    if (!title || !startDate || !location || !description) {
      return res.status(400).json({ error: "Title, startDate, location, and description are required." });
    }

    const event = await (prisma as any).event.create({
      data: {
        title: String(title).trim(),
        category: String(category || "Academic").trim(),
        startDate: String(startDate).trim(),
        endDate: String(startDate).trim(),
        location: String(location).trim(),
        audience: String(audience || "All").trim(),
        description: String(description).trim(),
      },
    });

    res.status(201).json({ event, message: "Academic Event saved to database successfully!" });
  } catch (err: any) {
    console.error("[events] create:", err);
    res.status(500).json({ error: err?.message || "Failed to create event" });
  }
});

// PUT /api/admin/events/:id - Admin update event in MongoDB
router.put("/admin/events/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, startDate, location, audience, description } = req.body;

    if (!title || !startDate || !location || !description) {
      return res.status(400).json({ error: "Title, startDate, location, and description are required." });
    }

    const updatedEvent = await (prisma as any).event.update({
      where: { id },
      data: {
        title: String(title).trim(),
        category: String(category || "Academic").trim(),
        startDate: String(startDate).trim(),
        endDate: String(startDate).trim(),
        location: String(location).trim(),
        audience: String(audience || "All").trim(),
        description: String(description).trim(),
      },
    });

    res.json({ event: updatedEvent, message: "Academic Event updated successfully!" });
  } catch (err: any) {
    console.error("[events] update:", err);
    res.status(500).json({ error: err?.message || "Failed to update event" });
  }
});

// DELETE /api/admin/events/:id - Admin delete event
router.delete("/admin/events/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    await (prisma as any).event.delete({
      where: { id },
    });
    res.json({ success: true, message: "Event deleted successfully." });
  } catch (err: any) {
    console.error("[events] delete:", err);
    res.status(500).json({ error: err?.message || "Failed to delete event" });
  }
});

export default router;

