param([Parameter(Mandatory)][string]$Origin, [Parameter(Mandatory)]$Browser)
$ErrorActionPreference = 'Stop'
$headers = @{ Origin=$Origin; Referer="$Origin/"; Accept='application/json' }
$settings = @{ model='openai/gpt-6-luna'; reasoning_effort='low'; access_mode='ask_first' } | ConvertTo-Json
Invoke-WebRequest "$Origin/settings" -Method Patch -Body $settings -ContentType 'application/json' `
    -Headers $headers -WebSession $Browser -UseBasicParsing | Out-Null
$prompt = 'Reply with exactly: Traceable Windows ready.'
$body = @{ chat_id='general'; text=$prompt; client_message_id=[guid]::NewGuid().ToString() } | ConvertTo-Json
Invoke-WebRequest "$Origin/messages" -Method Post -Body $body -ContentType 'application/json' `
    -Headers $headers -WebSession $Browser -UseBasicParsing | Out-Null
$delivered = $false
for ($attempt = 0; $attempt -lt 120 -and !$delivered; $attempt++) {
    $reply = Invoke-WebRequest "$Origin/turns?chat_id=general" -Headers $headers -WebSession $Browser -UseBasicParsing
    $turns = ($reply.Content | ConvertFrom-Json).data.turns
    $delivered = @($turns | Where-Object { $_.state -eq 'delivered' }).Count -gt 0
    if (@($turns | Where-Object { $_.state -in @('failed','cancelled') }).Count) { throw 'Stub chat failed' }
    if (!$delivered) { Start-Sleep -Milliseconds 500 }
}
if (!$delivered) { throw 'Stub chat did not deliver' }
$reply = Invoke-WebRequest "$Origin/messages?chat_id=general" -Headers $headers -WebSession $Browser -UseBasicParsing
$messages = @(($reply.Content | ConvertFrom-Json).data.messages)
if ($messages.Count -ne 2 -or $messages[0].text -ne $prompt -or $messages[1].text -ne 'Traceable Windows ready.') {
    throw 'Stub chat result does not match the complete conversation'
}
Write-Output 'Stub chat proof: one delivered turn; exact reply and complete two-message conversation'
