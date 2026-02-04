#!/bin/bash
# Validation script for OpenAPI refactoring iterations
# Usage: ./scripts/validate-openapi.sh [endpoint-path]
# Example: ./scripts/validate-openapi.sh /api/types

set -e

ENDPOINT="${1:-/health}"
BASE_URL="http://localhost:8787"

echo "🔍 Validating OpenAPI integration for endpoint: $ENDPOINT"
echo ""

# Check if dev server is running
if ! curl -s "$BASE_URL/health" > /dev/null; then
    echo "❌ Dev server not running at $BASE_URL"
    echo "   Run: npm run dev"
    exit 1
fi

echo "✅ Dev server is running"

# Check if endpoint exists in OpenAPI spec
echo "📄 Checking OpenAPI spec..."
SPEC=$(curl -s "$BASE_URL/docs/openapi.json")

if echo "$SPEC" | jq -e ".paths.\"$ENDPOINT\"" > /dev/null 2>&1; then
    echo "✅ Endpoint found in OpenAPI spec"
    echo ""
    echo "📋 Endpoint details:"
    echo "$SPEC" | jq ".paths.\"$ENDPOINT\"" | head -30
else
    echo "❌ Endpoint NOT found in OpenAPI spec"
    echo "   Available endpoints:"
    echo "$SPEC" | jq -r '.paths | keys[]' | grep -E "^$ENDPOINT" || echo "   (no matches)"
    exit 1
fi

echo ""
echo "✅ Validation complete!"
echo ""
echo "Next steps:"
echo "  1. Test the endpoint manually: curl $BASE_URL$ENDPOINT"
echo "  2. Check Scalar UI: open http://localhost:8787/docs"
echo "  3. Check off the item in OPENAPI_REFACTOR_PLAN.md"
echo "  4. Commit: git commit -m 'Convert $ENDPOINT to OpenAPIHono'"
