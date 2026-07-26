export interface OperationOutputView {
  turn_id: string;
  request_id: string;
  result_id: string;
  content: string;
  byte_start: number;
  byte_end: number;
  byte_length: number;
  complete: boolean;
}
