const http = require('http');

// Test configuration
const BASE_URL = 'http://localhost:3000';
const TEST_SCENARIOS = [
    {
        time: '08:00:00',
        user: 'U1',
        ip: '1.1.1.1',
        action: 'request',
        purpose: 'login',
        description: 'U1, IP 1.1.1.1 → /otp/request purpose=login'
    },
    {
        time: '08:03:00',
        user: 'U1',
        ip: '1.1.1.1',
        action: 'request',
        purpose: 'login',
        description: 'U1, IP 1.1.1.1 → /otp/request (same purpose)'
    },
    {
        time: '08:04:00',
        user: 'U1',
        action: 'verify',
        code: '000000',
        purpose: 'login',
        description: 'U1 → /otp/verify with wrong code'
    },
    {
        time: '08:04:20',
        user: 'U1',
        action: 'verify',
        code: '000000',
        purpose: 'login',
        description: 'U1 → /otp/verify with wrong code'
    },
    {
        time: '08:04:40',
        user: 'U1',
        action: 'verify',
        code: 'CORRECT',
        purpose: 'login',
        description: 'U1 → /otp/verify with correct code (concurrent)'
    },
    {
        time: '08:05:10',
        user: 'U1',
        ip: '1.1.1.1',
        action: 'request',
        purpose: 'login',
        description: 'U1 → /otp/request (within 15-min window)'
    },
    {
        time: '08:07:00',
        user: 'U2',
        ip: '1.1.1.1',
        action: 'request',
        purpose: 'login',
        description: 'U2, IP 1.1.1.1 → /otp/request'
    },
    {
        time: '08:12:00',
        user: 'U1',
        ip: '1.1.1.1',
        action: 'request',
        purpose: 'login',
        description: 'U1 → /otp/request (ensure per-user window math is correct)'
    }
];

// Store OTP codes for verification
const otpCodes = {};

function makeRequest(method, path, data, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const jsonBody = body ? JSON.parse(body) : {};
                    resolve({ status: res.statusCode, body: jsonBody });
                } catch (e) {
                    resolve({ status: res.statusCode, body: body });
                }
            });
        });

        req.on('error', reject);
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function runTestScenario(scenario, index) {
    console.log(`\n${index + 1}. ${scenario.time} - ${scenario.description}`);
    
    try {
        let response;
        
        if (scenario.action === 'request') {
            const headers = {
                'idempotency-key': `test-key-${scenario.user}-${scenario.time}-${Math.random()}`,
                'x-forwarded-for': scenario.ip
            };
            
            response = await makeRequest('POST', '/otp/request', {
                user_id: scenario.user,
                purpose: scenario.purpose
            }, headers);
            
            // Store OTP for later verification (in real scenario, this would come from SMS/email)
            if (response.status === 201 && response.body.otp_id) {
                // This is a simulation - in real implementation, OTP comes from external channel
                console.log(`   [Generated OTP would be sent via SMS/Email for verification]`);
            }
            
        } else if (scenario.action === 'verify') {
            let code = scenario.code;
            
            // For "correct" code, we'd normally get this from SMS/email
            // For testing, we'll simulate having the correct code
            if (code === 'CORRECT') {
                code = '123456'; // Simulated correct code
                console.log('   [Using simulated correct OTP code: 123456]');
            }
            
            response = await makeRequest('POST', '/otp/verify', {
                user_id: scenario.user,
                purpose: scenario.purpose,
                code: code
            });
        }
        
        console.log(`   Response: [${response.status}, ${JSON.stringify(response.body)}]`);
        
    } catch (error) {
        console.error(`   Error: ${error.message}`);
    }
}

async function runAllTests() {
    console.log('=== OTP Backend Engineering Assignment - Test Execution ===');
    console.log('Testing event sequence as specified in requirements...\n');
    
    // Run scenarios sequentially to maintain timing order
    for (let i = 0; i < TEST_SCENARIOS.length; i++) {
        await runTestScenario(TEST_SCENARIOS[i], i);
        
        // Small delay between requests to simulate real timing
        if (i < TEST_SCENARIOS.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    console.log('\n=== Test Execution Complete ===');
    console.log('\nNote: In a real implementation:');
    console.log('- OTP codes would be sent via SMS/Email, not logged to console');
    console.log('- Correct codes would be obtained from the external channel');
    console.log('- This test script simulates the behavioral flow');
}

// Run tests if this file is executed directly
if (require.main === module) {
    runAllTests().catch(console.error);
}

module.exports = { runAllTests };