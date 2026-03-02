import re
import json
import os

def parse_openrouter_yml(file_path):
    with open(file_path, 'r') as f:
        content = f.read()

    # Split by model block start
    # Simplified regex-based parsing for YAML-like structure
    models = []
    # Each model entry starts with "- id:"
    blocks = content.split('\n  - id: ')
    if len(blocks) <= 1:
        # Try without space
        blocks = content.split('\n- id: ')

    for block in blocks[1:]: # skip the header
        lines = block.split('\n')
        model_id = lines[0].strip().strip('"')
        
        input_price = 0.0
        output_price = 0.0
        
        for line in lines:
            if 'input_mtok:' in line:
                m = re.search(r'input_mtok:\s*([0-9\.]+)', line)
                if m: input_price = float(m.group(1))
            if 'output_mtok:' in line:
                m = re.search(r'output_mtok:\s*([0-9\.]+)', line)
                if m: output_price = float(m.group(1))
        
        # Determine size from id if possible
        size_match = re.search(r'(\d+)b', model_id.lower())
        size_b = int(size_match.group(1)) if size_match else None
        
        models.append({
            "name": model_id,
            "type": "chat",
            "size_b": size_b,
            "input_price_per_1m": input_price,
            "output_price_per_1m": output_price,
            "currency": "USD"
        })
    
    return models

openrouter_models = parse_openrouter_yml('openrouter_prices.yml')

# Load existing providers
with open('data/providers.json', 'r') as f:
    data = json.load(f)

# Update or Add OpenRouter
found = False
for provider in data['providers']:
    if provider['name'] == 'OpenRouter':
        provider['models'] = openrouter_models
        found = True
        break

if not found:
    data['providers'].append({
        "name": "OpenRouter",
        "url": "https://openrouter.ai/models",
        "headquarters": "USA",
        "region": "Global",
        "gdpr_compliant": False,
        "eu_endpoints": False,
        "models": openrouter_models
    })

with open('data/providers.json', 'w') as f:
    json.dump(data, f, indent=2)

print(f"Updated OpenRouter with {len(openrouter_models)} models.")
