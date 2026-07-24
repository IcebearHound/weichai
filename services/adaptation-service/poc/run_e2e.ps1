param([string]$Key)
$env:DEEPSEEK_API_KEY = $Key
python "$PSScriptRoot/e2e_pipeline.py"
