
import { connection } from "../../connection.js";

// GET: Fetch all enquiries
export const getEnquiries = (req, res) => {
    const q = "SELECT * FROM enquiry ORDER BY id DESC";

    connection.query(q, (err, data) => {
        if (err) {
            console.error("Error fetching enquiries:", err.message);

            return res.status(500).json({
                message: "Failed to fetch enquiries"
            });
        }

        return res.status(200).json(data.rows);
    });
};

// POST: Create a new enquiry
export const createEnquiry = (req, res) => {
    const {
        customer_name,
        mobile,
        address,
        required_area,
        purchase_plan,
        remark
    } = req.body;

    if (!customer_name || !mobile) {
        return res.status(400).json({
            message: "Customer name and mobile are required"
        });
    }

    const q = `
        INSERT INTO enquiry (
            customer_name,
            mobile,
            address,
            required_area,
            purchase_plan,
            remark
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `;

    const values = [
        customer_name,
        mobile,
        address ?? null,
        required_area ?? null,
        purchase_plan ?? null,
        remark ?? null
    ];

    connection.query(q, values, (err, data) => {
        if (err) {
            console.error("Error creating enquiry:", err.message);

            return res.status(500).json({
                message: "Failed to create enquiry"
            });
        }

        return res.status(201).json({
            message: "Enquiry created successfully",
            enquiry: data.rows[0]
        });
    });
};

// PATCH: Update an enquiry's remark
export const updateEnquiry = (req, res) => {
    const { id } = req.params;
    const { remark } = req.body;
    const enquiryId = Number(id);

    if (!/^\d+$/.test(id) || !Number.isSafeInteger(enquiryId) || enquiryId < 1) {
        return res.status(400).json({
            message: "A valid enquiry ID is required"
        });
    }

    if (remark === undefined || (remark !== null && typeof remark !== "string")) {
        return res.status(400).json({
            message: "Remark must be a string or null"
        });
    }

    const q = `
        UPDATE enquiry
        SET remark = $1,
            created_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
    `;

    connection.query(q, [remark, enquiryId], (err, data) => {
        if (err) {
            console.error("Error updating enquiry:", err.message);

            return res.status(500).json({
                message: "Failed to update enquiry"
            });
        }

        if (data.rowCount === 0) {
            return res.status(404).json({
                message: "Enquiry not found"
            });
        }

        return res.status(200).json({
            message: "Enquiry updated successfully",
            enquiry: data.rows[0]
        });
    });
};
