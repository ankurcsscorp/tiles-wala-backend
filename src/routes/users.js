import {currentUser,listManagedUsers,permissionCatalog,updateManagedUser,updateRolePermissions} from '../controllers/users.js';
import express from "express";
import { connection } from "../../connection.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();
router.get('/me',requireAuth,currentUser);
router.get('/referrals/search',requireAuth,async(req,res)=>{
  const q=String(req.query.q||'').trim();
  if(q.length<2||q.length>100)return res.status(200).json({items:[]});
  try{const result=await connection.query(`SELECT id,name,mobile,user_type,area_location FROM users WHERE is_active=TRUE AND user_type IN ('Salesperson','Tile Mistire') AND (name ILIKE $1 OR mobile ILIKE $1) ORDER BY name,id LIMIT 15`,[`%${q}%`]);return res.json({items:result.rows.map(user=>({id:user.id,name:user.name,mobile:user.mobile,userType:user.user_type,areaLocation:user.area_location||null}))});}
  catch(error){console.error('Error searching referral users:',error.message);return res.status(500).json({message:'Unable to search referral users'});}
});
router.get('/',requireAuth,requireUserTypes('Admin'),listManagedUsers);
router.get('/permissions',requireAuth,requireUserTypes('Admin'),permissionCatalog);
router.put('/roles/:userType',requireAuth,requireUserTypes('Admin'),updateRolePermissions);
router.put('/:id/access',requireAuth,requireUserTypes('Admin'),updateManagedUser);

router.get("/search", requireAuth, requireUserTypes("Admin"), async (req, res) => {
  try {
    const rawQuery = req.query.q;

    if (typeof rawQuery !== "string" || !rawQuery.trim() || rawQuery.trim().length > 100) {
      return res.status(400).json({
        message: "Search query is required and must be 100 characters or fewer",
      });
    }

    const result = await connection.query(
      `SELECT id, name, mobile, user_type, area_location, created_at
       FROM users
       WHERE user_type = ANY($1::varchar[])
         AND (
           LOWER(name) LIKE LOWER($2)
           OR mobile LIKE $2
         )
       ORDER BY name ASC, id ASC
       LIMIT 12;`,
      [["Salesperson", "Tile Mistire"], `%${rawQuery.trim()}%`]
    );

    return res.status(200).json(
      result.rows.map((user) => ({
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        userType: user.user_type,
        areaLocation: user.area_location ?? null,
        createdAt: user.created_at,
      }))
    );
  } catch (error) {
    console.error("Error searching users:", error.message);
    return res.status(500).json({ message: "Unable to search users" });
  }
});

export default router;
