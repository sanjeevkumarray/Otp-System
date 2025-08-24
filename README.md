# OTP Backend Engineering Assignment

A MySQL + Node.js OTP (One-Time Password) system with rate limiting, concurrency control, and idempotency.

## Stack Constraints
- ✅ MySQL 8.x and Node.js only
- ❌ No Redis/queues/cron/caches/ORMs
- ✅ Raw SQL + minimal HTTP server (Express)

## Features

### Core Functionality
- **POST /otp/request** - Generate and send OTP
- **POST /otp/verify** - Verify OTP code

### Security & Constraints
- 6-digit cryptographically random OTP
- 5-minute TTL
- Single active OTP per (user_id, purpose)
- Rate limiting: 3 requests/15min per user, 8 requests/15min per IP
- Max 3 wrong attempts → 10-minute lockout
- Atomic verification (concurrent requests handled)
- Idempotency with `Idempotency-Key` header

## Project Structure

```
otp-backend-assignment/
├── schema.sql          # MySQL database schema
├── server.js           # Node.js server implementation
├── package.json        # Dependencies
├── .env.example        # Environment configuration template
├── test.js            # Test script for event sequence
└── README.md          # This file
```

## Setup Instructions

### 1. Prerequisites
- Node.js 16+ 
- MySQL 8.x
- Basic familiarity with SQL and REST APIs

### 2. Database Setup
```bash
# Login to MySQL
mysql -u root -p

# Create database and tables
source schema.sql
```

### 3. Application Setup
```bash
# Clone/download the project files
# Navigate to project directory

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit .env with your MySQL credentials
# DB_HOST=localhost
# DB_USER=root  
# DB_PASSWORD=yourpassword
```

### 4. Start Server
```bash
# Development mode
npm run dev

# Production mode  
npm start
```

Server runs on `http://localhost:3000`

## API Documentation

### POST /otp/request
Generate and send OTP to user.

**Headers:**
- `Content-Type: application/json`
- `Idempotency-Key: <unique-key>` (required)

**Body:**
```json
{
  "user_id": "string",
  "purpose": "string"
}
```

**Success Response (201):**
```json
{
  "otp_id": "12345",
  "ttl": 300,
  "remaining_requests": 2
}
```

**Rate Limited Response (429):**
```json
{
  "error": "rate_limit_exceeded", 
  "remaining_cooldown_seconds": 120
}
```

### POST /otp/verify
Verify OTP code.

**Body:**
```json
{
  "user_id": "string",
  "purpose": "string", 
  "code": "123456"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "verification_successful"
}
```

**Invalid Code Response (401):**
```json
{
  "error": "invalid_code",
  "attempts_remaining": 2
}
```

**Code Already Used (410):**
```json
{
  "error": "code_used"
}
```

**Too Many Attempts (429):**
```json
{
  "error": "too_many_attempts",
  "retry_after_seconds": 600
}
```

## Testing

Run the test script to verify the event sequence:

```bash
npm test
```

This executes the 8-step scenario specified in the requirements and shows expected HTTP responses.

## Architecture Details

### Database Design
- **otps**: Main table with unique constraint for single active OTP
- **user_rate_limits**: Rolling window rate limiting per user
- **ip_rate_limits**: Rolling window rate limiting per IP  
- **idempotency_keys**: Prevents duplicate processing

### Concurrency Control
- `SELECT ... FOR UPDATE` locks for atomic operations
- Transaction isolation prevents race conditions
- First successful verification wins, concurrent attempts fail with 410

### Rate Limiting
- Rolling window implemented via timestamp queries
- No external dependencies (Redis/cron)
- Automatic cleanup of old records

### Time Handling
- All time operations use MySQL `NOW()` function
- Consistent server-side timing
- No reliance on application clock

## Key SQL Queries

**Rate Limit Check:**
```sql
SELECT COUNT(*) FROM user_rate_limits 
WHERE user_id = ? AND request_timestamp >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
```

**Atomic OTP Verification:**
```sql
UPDATE otps SET is_used = TRUE 
WHERE id = ? AND is_used = FALSE
```

**Single Active OTP Constraint:**
```sql
UNIQUE KEY uk_user_purpose_active (user_id, purpose, is_used, is_locked)
```

## Production Considerations

- Add proper logging (Winston/Bunyan)
- Implement health checks and metrics
- Use connection pooling (already implemented)
- Add input validation middleware  
- Set up proper error monitoring
- Configure rate limiting headers
- Add HTTPS/TLS termination
- Database connection retry logic
-