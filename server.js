const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: 'otp_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Generate cryptographically random 6-digit OTP
function generateOTP() {
    const randomBytes = crypto.randomBytes(4);
    const randomNumber = randomBytes.readUInt32BE(0);
    return String(randomNumber % 1000000).padStart(6, '0');
}

// Get client IP address
function getClientIP(req) {
    return req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || '127.0.0.1';
}

// Check and update rate limits - returns remaining requests or throws error
async function checkRateLimits(connection, userId, ipAddress) {
    const now = new Date();
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
    
    // Check per-user rate limit (max 3 requests / 15 minutes)
    const [userRequests] = await connection.execute(
        'SELECT COUNT(*) as count FROM user_rate_limits WHERE user_id = ? AND request_timestamp >= ?',
        [userId, fifteenMinutesAgo]
    );
    
    if (userRequests[0].count >= 3) {
        // Find oldest request to calculate remaining cooldown
        const [oldestRequest] = await connection.execute(
            'SELECT request_timestamp FROM user_rate_limits WHERE user_id = ? AND request_timestamp >= ? ORDER BY request_timestamp ASC LIMIT 1',
            [userId, fifteenMinutesAgo]
        );
        const cooldownUntil = new Date(oldestRequest[0].request_timestamp.getTime() + 15 * 60 * 1000);
        const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
        throw { status: 429, body: { error: 'rate_limit_exceeded', remaining_cooldown_seconds: remainingSeconds } };
    }
    
    // Check per-IP rate limit (max 8 requests / 15 minutes)
    const [ipRequests] = await connection.execute(
        'SELECT COUNT(*) as count FROM ip_rate_limits WHERE ip_address = ? AND request_timestamp >= ?',
        [ipAddress, fifteenMinutesAgo]
    );
    
    if (ipRequests[0].count >= 8) {
        const [oldestRequest] = await connection.execute(
            'SELECT request_timestamp FROM ip_rate_limits WHERE ip_address = ? AND request_timestamp >= ? ORDER BY request_timestamp ASC LIMIT 1',
            [ipAddress, fifteenMinutesAgo]
        );
        const cooldownUntil = new Date(oldestRequest[0].request_timestamp.getTime() + 15 * 60 * 1000);
        const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
        throw { status: 429, body: { error: 'rate_limit_exceeded', remaining_cooldown_seconds: remainingSeconds } };
    }
    
    // Record this request for rate limiting
    await connection.execute(
        'INSERT INTO user_rate_limits (user_id, request_timestamp) VALUES (?, NOW())',
        [userId]
    );
    await connection.execute(
        'INSERT INTO ip_rate_limits (ip_address, request_timestamp) VALUES (?, NOW())',
        [ipAddress]
    );
    
    return {
        user_remaining: 3 - userRequests[0].count - 1,
        ip_remaining: 8 - ipRequests[0].count - 1
    };
}

// POST /otp/request
app.post('/otp/request', async (req, res) => {
    const { user_id, purpose } = req.body;
    const idempotencyKey = req.headers['idempotency-key'];
    const ipAddress = getClientIP(req);
    
    // Validate required fields
    if (!user_id || !purpose || !idempotencyKey) {
        return res.status(400).json({ error: 'missing_required_fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        // Check idempotency first
        const [existingIdempotency] = await connection.execute(
            'SELECT response_data FROM idempotency_keys WHERE idempotency_key = ? AND expires_at > NOW()',
            [idempotencyKey]
        );
        
        if (existingIdempotency.length > 0) {
            await connection.commit();
            return res.status(200).json(JSON.parse(existingIdempotency[0].response_data));
        }
        
        // Check rate limits
        const rateLimitInfo = await checkRateLimits(connection, user_id, ipAddress);
        
        // Lock and check for existing active OTP
        const [existingOTP] = await connection.execute(
            'SELECT id FROM otps WHERE user_id = ? AND purpose = ? AND is_used = FALSE AND is_locked = FALSE AND expires_at > NOW() FOR UPDATE',
            [user_id, purpose]
        );
        
        if (existingOTP.length > 0) {
            // Invalidate existing OTP by marking as used
            await connection.execute(
                'UPDATE otps SET is_used = TRUE WHERE id = ?',
                [existingOTP[0].id]
            );
        }
        
        // Generate new OTP
        const otpCode = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes TTL
        
        // Insert new OTP
        const [insertResult] = await connection.execute(
            'INSERT INTO otps (user_id, purpose, code, expires_at) VALUES (?, ?, ?, ?)',
            [user_id, purpose, otpCode, expiresAt]
        );
        
        const response = {
            otp_id: insertResult.insertId.toString(),
            ttl: 300, // 5 minutes in seconds
            remaining_requests: rateLimitInfo.user_remaining
        };
        
        // Store idempotency result
        const idempotencyExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await connection.execute(
            'INSERT INTO idempotency_keys (idempotency_key, user_id, purpose, response_data, expires_at) VALUES (?, ?, ?, ?, ?)',
            [idempotencyKey, user_id, purpose, JSON.stringify(response), idempotencyExpires]
        );
        
        await connection.commit();
        
        // In real implementation, send OTP via SMS/email here
        console.log(`OTP for ${user_id}:${purpose} = ${otpCode}`); // Development only
        
        res.status(201).json(response);
        
    } catch (error) {
        await connection.rollback();
        
        if (error.status) {
            return res.status(error.status).json(error.body);
        }
        
        console.error('OTP request error:', error);
        res.status(500).json({ error: 'internal_server_error' });
    } finally {
        connection.release();
    }
});

// POST /otp/verify
app.post('/otp/verify', async (req, res) => {
    const { user_id, purpose, code } = req.body;
    
    // Validate required fields
    if (!user_id || !purpose || !code) {
        return res.status(400).json({ error: 'missing_required_fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        // Lock the OTP record for update
        const [otpRecords] = await connection.execute(
            'SELECT id, code, is_used, is_locked, locked_until, attempt_count, expires_at FROM otps WHERE user_id = ? AND purpose = ? AND is_used = FALSE ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
            [user_id, purpose]
        );
        
        if (otpRecords.length === 0) {
            await connection.commit();
            return res.status(404).json({ error: 'otp_not_found' });
        }
        
        const otp = otpRecords[0];
        const now = new Date();
        
        // Check if OTP is expired
        if (new Date(otp.expires_at) < now) {
            await connection.execute('UPDATE otps SET is_used = TRUE WHERE id = ?', [otp.id]);
            await connection.commit();
            return res.status(410).json({ error: 'otp_expired' });
        }
        
        // Check if OTP is locked due to too many attempts
        if (otp.is_locked && otp.locked_until && new Date(otp.locked_until) > now) {
            const remainingSeconds = Math.ceil((new Date(otp.locked_until) - now) / 1000);
            await connection.commit();
            return res.status(429).json({ error: 'too_many_attempts', retry_after_seconds: remainingSeconds });
        } else if (otp.is_locked && otp.locked_until && new Date(otp.locked_until) <= now) {
            // Unlock if lock period has expired
            await connection.execute(
                'UPDATE otps SET is_locked = FALSE, locked_until = NULL, attempt_count = 0 WHERE id = ?',
                [otp.id]
            );
            otp.is_locked = false;
            otp.attempt_count = 0;
        }
        
        // Check if OTP is already used (handles concurrent verification)
        if (otp.is_used) {
            await connection.commit();
            return res.status(410).json({ error: 'code_used' });
        }
        
        // Verify the code
        if (otp.code === code) {
            // SUCCESS - Mark as used atomically (first successful verify wins)
            const [updateResult] = await connection.execute(
                'UPDATE otps SET is_used = TRUE WHERE id = ? AND is_used = FALSE',
                [otp.id]
            );
            
            if (updateResult.affectedRows === 0) {
                // Another concurrent request already marked it as used
                await connection.commit();
                return res.status(410).json({ error: 'code_used' });
            }
            
            await connection.commit();
            return res.status(200).json({ success: true, message: 'verification_successful' });
            
        } else {
            // FAILURE - Increment attempt count
            const newAttemptCount = otp.attempt_count + 1;
            
            if (newAttemptCount >= 3) {
                // Lock for 10 minutes after 3 failed attempts
                const lockedUntil = new Date(now.getTime() + 10 * 60 * 1000);
                await connection.execute(
                    'UPDATE otps SET attempt_count = ?, is_locked = TRUE, locked_until = ? WHERE id = ?',
                    [newAttemptCount, lockedUntil, otp.id]
                );
                await connection.commit();
                return res.status(429).json({ error: 'too_many_attempts', retry_after_seconds: 600 });
            } else {
                await connection.execute(
                    'UPDATE otps SET attempt_count = ? WHERE id = ?',
                    [newAttemptCount, otp.id]
                );
                await connection.commit();
                return res.status(401).json({ 
                    error: 'invalid_code', 
                    attempts_remaining: 3 - newAttemptCount 
                });
            }
        }
        
    } catch (error) {
        await connection.rollback();
        console.error('OTP verify error:', error);
        res.status(500).json({ error: 'internal_server_error' });
    } finally {
        connection.release();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`OTP server running on port ${PORT}`);
});

module.exports = app;