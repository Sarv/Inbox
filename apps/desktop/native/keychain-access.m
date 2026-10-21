// The password prompt belongs to macOS. Never accept a password, inspect a
// Keychain item, or change a user's Keychain configuration in this helper.
#import <Security/Security.h>
#include <stdio.h>
#include <string.h>

int main(int argc, const char *argv[]) {
  const int checkOnly = argc == 2 && strcmp(argv[1], "--check") == 0;
  OSStatus status = errSecParam;
  if (argc == 1 || checkOnly) {
    SecKeychainRef keychain = NULL;
    status = SecKeychainCopyDefault(&keychain);
    if (status == errSecSuccess && keychain != NULL) {
      if (checkOnly) {
        SecKeychainStatus metadata = 0;
        status = SecKeychainGetStatus(keychain, &metadata);
      } else {
        // With usePassword=false and no supplied bytes, Security.framework owns
        // any authorization UI. An already-unlocked keychain may return zero
        // without validating its cached encryption state. The app must perform
        // a separate, nonsecret encryption/decryption probe after this call.
        status = SecKeychainUnlock(keychain, 0, NULL, false);
      }
    } else if (status == errSecSuccess) {
      status = errSecInvalidKeychain;
    }
    if (keychain != NULL) CFRelease(keychain);
  }
  // Only OSStatus crosses the process boundary: no account, item or password.
  printf("{\"status\":%d}\n", (int)status);
  return 0;
}
