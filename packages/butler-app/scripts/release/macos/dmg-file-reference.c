// Prints the Finder references for a file on a mounted disk image as JSON:
// {"alias":"<hex Alias Manager record>","bookmark":"<hex bookmark>"}.
//
// Finder stores a DMG window background as a classic alias inside the `icvp`
// view options and as a bookmark (`pBBk`). Both are created here from the file
// on the mounted image so they resolve against the image's own volume. The
// Alias Manager is deprecated and not exposed to Swift, but it remains the
// format Finder reads, so this helper is plain C.
#include <CoreServices/CoreServices.h>
#include <stdio.h>
#include <string.h>

static void print_hex(const UInt8 *bytes, CFIndex length) {
  for (CFIndex index = 0; index < length; index += 1) printf("%02x", bytes[index]);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: dmg-file-reference <path-on-mounted-image>\n");
    return 64;
  }
  const char *path = argv[1];

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  AliasHandle alias = NULL;
  OSStatus status = FSNewAliasFromPath(NULL, path, 0, &alias, NULL);
  if (status != noErr || alias == NULL || *alias == NULL) {
    fprintf(stderr, "alias creation failed for %s: OSStatus %d\n", path, (int)status);
    return 1;
  }
  Size alias_size = GetAliasSizeFromPtr(*alias);
#pragma clang diagnostic pop

  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
    NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
  CFErrorRef error = NULL;
  CFDataRef bookmark = url ? CFURLCreateBookmarkData(NULL, url, 0, NULL, NULL, &error) : NULL;
  if (bookmark == NULL) {
    fprintf(stderr, "bookmark creation failed for %s\n", path);
    return 1;
  }

  printf("{\"alias\":\"");
  print_hex((const UInt8 *)*alias, (CFIndex)alias_size);
  printf("\",\"bookmark\":\"");
  print_hex(CFDataGetBytePtr(bookmark), CFDataGetLength(bookmark));
  printf("\"}\n");

  CFRelease(bookmark);
  CFRelease(url);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  DisposeHandle((Handle)alias);
#pragma clang diagnostic pop
  return 0;
}
