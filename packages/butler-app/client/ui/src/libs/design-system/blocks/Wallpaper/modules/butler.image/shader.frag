// Image: the asset fitted to the canvas (cover crops; contain letterboxes onto a
// neutral field that follows the theme) and blurred through its mip levels.
// Engine-internal: the renderer sets these for the built-in module only.
uniform vec4 image_fit;  // image uv = canvas uv * xy + zw
uniform vec3 image_blur; // xy: tap offset in image uv, z: mip level

vec4 imageTap(vec2 uv,vec2 offset){return textureLod(u_image,uv+offset*image_blur.xy,image_blur.z);}

void main(){
  vec3 field=mix(vec3(.96,.96,.965),vec3(.102,.106,.118),u_dark);
  vec2 uv=gl_FragCoord.xy/u_resolution*image_fit.xy+image_fit.zw;
  // Unblurred: one trilinear sample (the hardware picks the level that anti-aliases a downscale).
  // Blurred: center plus four rotated taps smooth the bilinear blocks of a high mip level.
  vec4 image=image_blur.xy==vec2(0.)?texture(u_image,uv)
    :(imageTap(uv,vec2(0.))*2.+imageTap(uv,vec2(1.,.5))+imageTap(uv,vec2(-.5,1.))
    +imageTap(uv,vec2(-1.,-.5))+imageTap(uv,vec2(.5,-1.)))/6.;
  vec2 inside=step(vec2(0.),uv)*step(uv,vec2(1.));
  // Premultiplied image over the field; the bars of contain and a missing image show the field.
  vec3 color=image.rgb+field*(1.-image.a);
  fragColor=vec4(mix(field,color,inside.x*inside.y*u_hasImage),1.);
}
