const Database = require('better-sqlite3');
const db = new Database('./data/manatee.db');

console.log("--- 1) Users ---");
const users = db.prepare('SELECT id, email, title, first_name, surname, role FROM users').all();
console.table(users);

console.log("\n--- 2) Mentorships ---");
// Assuming the SQL expression from admin.js for names is something like:
// mentor.first_name || ' ' || mentor.surname
const mentorships = db.prepare(`
    SELECT 
        m.id,
        mentor.first_name || ' ' || mentor.surname AS mentor_name,
        mentee.first_name || ' ' || mentee.surname AS mentee_name
    FROM mentorships m
    JOIN users mentor ON m.mentor_id = mentor.id
    JOIN users mentee ON m.mentee_id = mentee.id
`).all();
console.table(mentorships);
