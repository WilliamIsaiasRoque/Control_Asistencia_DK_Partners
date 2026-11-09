$ErrorActionPreference = 'Stop'

$projectUrl = 'https://evnfjzomveojmxbvyeav.supabase.co'

function Read-SecretText([string]$Prompt) {
  $secureValue = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$serviceKey = Read-SecretText 'Pega la Secret API key (sb_secret_...) o service_role key de Supabase'
$email = (Read-Host 'Correo exacto de la cuenta existente').Trim().ToLowerInvariant()
$password = Read-SecretText 'Nueva contraseña temporal (mínimo 8 caracteres)'
$passwordAgain = Read-SecretText 'Repite la contraseña temporal'

if (-not $serviceKey) { throw 'La clave de servidor es obligatoria.' }
if ($password.Length -lt 8) { throw 'La contraseña debe tener al menos 8 caracteres.' }
if ($password -cne $passwordAgain) { throw 'Las contraseñas no coinciden.' }

$headers = @{
  apikey        = $serviceKey
  Authorization = "Bearer $serviceKey"
}

try {
  $usersResponse = Invoke-RestMethod -Method Get `
    -Uri "$projectUrl/auth/v1/admin/users?page=1&per_page=100" `
    -Headers $headers `
    -UserAgent 'DKPartnersPasswordSetup/1.0'

  $users = @($usersResponse.users)
  $matchedUsers = @($users | Where-Object { $_.email -and $_.email.ToLowerInvariant() -eq $email })

  if ($matchedUsers.Count -eq 0) {
    throw "No encontré una cuenta con ese correo en la primera página de usuarios. No se modificó ninguna cuenta."
  }
  if ($matchedUsers.Count -gt 1) {
    throw 'Encontré más de una coincidencia; no se modificó ninguna cuenta.'
  }

  $userId = [Uri]::EscapeDataString([string]$matchedUsers[0].id)
  $body = @{
    password     = $password
    email_confirm = $true
  } | ConvertTo-Json

  $null = Invoke-RestMethod -Method Put `
    -Uri "$projectUrl/auth/v1/admin/users/$userId" `
    -Headers $headers `
    -UserAgent 'DKPartnersPasswordSetup/1.0' `
    -ContentType 'application/json' `
    -Body $body

  Write-Host "Contraseña temporal asignada a $email. Ya puedes iniciar sesión en la app."
} finally {
  $serviceKey = $null
  $password = $null
  $passwordAgain = $null
  $body = $null
  $headers = $null
  [GC]::Collect()
}
